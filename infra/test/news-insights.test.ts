import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestNewsInsights", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

const fn = (name: string) =>
  Object.entries(
    template.findResources("AWS::Lambda::Function", { Properties: { FunctionName: name } }),
  )[0];
const statementsOf = (prefix: string) =>
  (Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
    id.startsWith(prefix),
  )?.[1]?.Properties?.PolicyDocument?.Statement ?? []) as Array<{
    Action: string | string[];
    Resource: unknown;
  }>;
const actionsOn = (statements: ReturnType<typeof statementsOf>, table: string) =>
  statements
    .filter((st) => JSON.stringify(st.Resource).includes(`"${table}`))
    .flatMap((st) => [st.Action].flat())
    .sort((a, b) => a.localeCompare(b));

describe("AI Insights (Phase 39)", () => {
  it("keeps one row per day in its own table: the feed + the day", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "slack-dev-news-insights",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "feed", KeyType: "HASH" },
        { AttributeName: "day", KeyType: "RANGE" },
      ],
    });
  });

  it("runs the worker every morning at 07:07 in Ecuador (12:07 UTC), with retries", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      Name: "slack-dev-news-insights",
      ScheduleExpression: "cron(7 12 * * ? *)",
      State: "ENABLED",
      Targets: [Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 2 } })],
    });
    const [, worker] = fn("slack-dev-news-insights-worker")!;
    expect(worker.Properties.Timeout).toBe(120);
    expect(JSON.stringify(worker.Properties.Environment.Variables.NEWS_INSIGHTS_TABLE)).toMatch(
      /DataNewsInsights/,
    );
  });

  it("the worker may only write the row and call the model; the endpoint only read it and start the worker", () => {
    const worker = statementsOf("TasksApiNewsInsightsWorkerFnServiceRoleDefaultPolicy");
    expect(actionsOn(worker, "DataNewsInsights")).toEqual(["dynamodb:PutItem"]);
    expect(worker.flatMap((st) => [st.Action].flat())).toContain("bedrock-mantle:CreateInference");
    expect(JSON.stringify(worker)).not.toMatch(/Messages|Channels|Users|s3:/);

    const endpoint = statementsOf("TasksApiNewsInsightsFnServiceRoleDefaultPolicy");
    expect(actionsOn(endpoint, "DataNewsInsights")).toEqual(["dynamodb:Query"]);
    const invoke = endpoint.filter((st) => [st.Action].flat().includes("lambda:InvokeFunction"));
    expect(JSON.stringify(invoke)).toMatch(/NewsInsightsWorkerFn/);
    expect(JSON.stringify(endpoint)).not.toMatch(/bedrock/);
  });

  it("serves GET and POST /news/insights behind the JWT authorizer from the endpoint Lambda", () => {
    for (const key of ["GET /news/insights", "POST /news/insights"]) {
      const route = Object.values(
        template.findResources("AWS::ApiGatewayV2::Route", { Properties: { RouteKey: key } }),
      )[0]?.Properties as { AuthorizationType: string; Target: unknown };
      expect(route.AuthorizationType).toBe("JWT");
      expect(JSON.stringify(route.Target)).toMatch(/NewsInsightsIntegration/);
    }
    const env = fn("slack-dev-news-insights")?.[1].Properties.Environment.Variables as Record<
      string,
      unknown
    >;
    expect(Object.keys(env).sort()).toEqual([
      "INSIGHTS_WORKER_FUNCTION",
      "LOG_LEVEL",
      "NEWS_INSIGHTS_TABLE",
      "STAGE",
    ]);
  });

  it("leaves the news proxy as it was: no data permissions", () => {
    const env = fn("slack-dev-news")?.[1].Properties.Environment.Variables as Record<
      string,
      string
    >;
    expect(Object.keys(env).sort()).toEqual(["LOG_LEVEL", "STAGE"]);
  });
});
