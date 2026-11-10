import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";
import { RADAR_ROUTES } from "../lib/tasks-api";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestRadar", {
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

describe("AI Tech Radar (Phase 56)", () => {
  it("keeps blips and proposals in one small table: the entity + the id", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "slack-dev-tech-radar",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "id", KeyType: "RANGE" },
      ],
    });
  });

  it("scans the news every morning after AI Insights (06:30 in Ecuador), with a retry", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      Name: "slack-dev-radar-scan",
      ScheduleExpression: "cron(30 11 * * ? *)",
      State: "ENABLED",
      Targets: [Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 1 } })],
    });
    const [, worker] = fn("slack-dev-radar-scan-worker")!;
    expect(worker.Properties.Timeout).toBe(180);
    expect(JSON.stringify(worker.Properties.Environment.Variables.TECH_RADAR_TABLE)).toMatch(
      /DataTechRadar/,
    );
  });

  it("the worker adds blips and proposals and asks the model; the endpoint owns the table and starts the worker", () => {
    const worker = statementsOf("TasksApiRadarScanWorkerFnServiceRoleDefaultPolicy");
    // DeleteItem: pruning old resolved proposals, never a blip (the handler checks the key).
    expect(actionsOn(worker, "DataTechRadar")).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]);
    const workerActions = worker.flatMap((st) => [st.Action].flat());
    expect(workerActions).toContain("bedrock:InvokeModel");
    expect(workerActions).not.toContain("bedrock:InvokeModelWithResponseStream");
    expect(JSON.stringify(worker)).toMatch(/inference-profile\/us\.anthropic\.claude-haiku-5-5/);
    expect(JSON.stringify(worker)).not.toMatch(/Messages|Channels|Users|NewsInsights/);

    const endpoint = statementsOf("TasksApiRadarFnServiceRoleDefaultPolicy");
    expect(actionsOn(endpoint, "DataTechRadar")).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    const invoke = endpoint.filter((st) => [st.Action].flat().includes("lambda:InvokeFunction"));
    expect(JSON.stringify(invoke)).toMatch(/RadarScanWorkerFn/);
    expect(endpoint.flatMap((st) => [st.Action].flat())).not.toContain("bedrock:InvokeModel");
  });

  it("serves every /radar route behind the JWT authorizer from the radar Lambda", () => {
    for (const { method, path } of RADAR_ROUTES) {
      const route = Object.values(
        template.findResources("AWS::ApiGatewayV2::Route", {
          Properties: { RouteKey: `${method} ${path}` },
        }),
      )[0]?.Properties as { AuthorizationType: string; Target: unknown } | undefined;
      expect(route, `${method} ${path}`).toBeDefined();
      expect(route!.AuthorizationType).toBe("JWT");
      expect(JSON.stringify(route!.Target)).toMatch(/RadarIntegration/);
    }
    const env = fn("slack-dev-radar")?.[1].Properties.Environment.Variables as Record<
      string,
      unknown
    >;
    expect(Object.keys(env).sort()).toEqual([
      "LOG_LEVEL",
      "RADAR_WORKER_FUNCTION",
      "STAGE",
      "TECH_RADAR_TABLE",
    ]);
  });
});
