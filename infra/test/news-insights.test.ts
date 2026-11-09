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

  it("runs the worker every morning at 08:00 in Ecuador (13:00 UTC), with retries", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      Name: "slack-dev-news-insights",
      ScheduleExpression: "cron(0 13 * * ? *)",
      State: "ENABLED",
      Targets: [Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 2 } })],
    });
    const [, worker] = fn("slack-dev-news-insights-worker")!;
    expect(worker.Properties.Timeout).toBe(360);
    expect(JSON.stringify(worker.Properties.Environment.Variables.NEWS_INSIGHTS_TABLE)).toMatch(
      /DataNewsInsights/,
    );
  });

  it("the worker may only write the row and call the model; the endpoint read it, claim a refresh and start the worker", () => {
    const worker = statementsOf("TasksApiNewsInsightsWorkerFnServiceRoleDefaultPolicy");
    // Phase 55: UpdateItem (the audio's claim, the audio added to its row), Query (the newest).
    expect(actionsOn(worker, "DataNewsInsights")).toEqual([
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(worker.flatMap((st) => [st.Action].flat())).toContain("bedrock:InvokeModel");
    // Phase 49: it streams the answer, which is its own action (without it every run is refused).
    expect(worker.flatMap((st) => [st.Action].flat())).toContain(
      "bedrock:InvokeModelWithResponseStream",
    );
    expect(JSON.stringify(worker)).toMatch(/inference-profile\/us\.anthropic\.claude-haiku-5-5/);
    expect(JSON.stringify(worker)).not.toMatch(/Messages|Channels|Users/);
    // Phase 54: the summary in audio: Polly, and writing under news-audio/ only.
    expect(worker.flatMap((st) => [st.Action].flat())).toContain("polly:SynthesizeSpeech");
    const s3 = worker.filter((st) => JSON.stringify(st.Action).includes("s3:"));
    expect(s3.flatMap((st) => [st.Action].flat())).toEqual(["s3:PutObject"]);
    expect(JSON.stringify(s3)).toMatch(/\/news-audio\/\*/);
    expect(JSON.stringify(s3)).not.toMatch(/attachments\/\*/);

    const endpoint = statementsOf("TasksApiNewsInsightsFnServiceRoleDefaultPolicy");
    // GetItem: the last failed run (Phase 49b).
    expect(actionsOn(endpoint, "DataNewsInsights")).toEqual([
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    const invoke = endpoint.filter((st) => [st.Action].flat().includes("lambda:InvokeFunction"));
    expect(JSON.stringify(invoke)).toMatch(/NewsInsightsWorkerFn/);
    // Phase 50: "Pregunta a la IA" asks the model from the endpoint: InvokeModel only, no stream.
    const endpointActions = endpoint.flatMap((st) => [st.Action].flat());
    expect(endpointActions).toContain("bedrock:InvokeModel");
    expect(endpointActions).not.toContain("bedrock:InvokeModelWithResponseStream");
    // Phase 54: it signs the audio's URL: reading news-audio/ only.
    const endpointS3 = endpoint.filter((st) => JSON.stringify(st.Action).includes("s3:"));
    expect(endpointS3.flatMap((st) => [st.Action].flat())).toEqual(["s3:GetObject"]);
    expect(JSON.stringify(endpointS3)).toMatch(/\/news-audio\/\*/);
  });

  it("keeps the audio summaries a month (Phase 54)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Id: "NewsAudio30Days", Prefix: "news-audio/", ExpirationInDays: 30 }),
        ]),
      },
    });
  });

  it("serves /news/insights and POST /news/refresh behind the JWT authorizer from the endpoint Lambda", () => {
    for (const key of ["GET /news/insights", "POST /news/insights", "POST /news/refresh"]) {
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
      "ATTACHMENTS_BUCKET",
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
