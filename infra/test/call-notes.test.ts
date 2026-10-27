import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestCallNotes", {
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

describe("AI call notes", () => {
  it("keeps the hub's pointers in their own table: userId + the card's sort key", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "slack-dev-meeting-notes",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "userId", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    });
    // GET /notes is served by the same Lambda as POST /calls/summary.
    const route = Object.values(
      template.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: "GET /notes" },
      }),
    )[0]?.Properties as { AuthorizationType: string; Target: unknown };
    expect(route.AuthorizationType).toBe("JWT");
    expect(JSON.stringify(route.Target)).toMatch(/CallNotesIntegration/);
  });

  it("serves POST /calls/summary behind the JWT authorizer from its own Lambda", () => {
    const routes = Object.values(
      template.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: "POST /calls/summary" },
      }),
    ).map((r) => r.Properties as { AuthorizationType: string; Target: unknown });
    expect(routes).toHaveLength(1);
    expect(routes[0]?.AuthorizationType).toBe("JWT");
    expect(JSON.stringify(routes[0]?.Target)).toMatch(/CallNotesIntegration/);
    const env = fn("slack-dev-call-notes")?.[1].Properties.Environment.Variables as Record<
      string,
      unknown
    >;
    expect(Object.keys(env).sort()).toEqual([
      "CHANNELS_TABLE",
      "CONNECTIONS_TABLE",
      "LOG_LEVEL",
      "MEETING_NOTES_TABLE",
      "MESSAGES_TABLE",
      "NOTES_WORKER_FUNCTION",
      "STAGE",
      "WS_ENDPOINT",
    ]);
  });

  it("runs the worker for up to 2 minutes with no async retries", () => {
    const worker = fn("slack-dev-call-notes-worker")?.[1];
    expect(worker?.Properties.Timeout).toBe(120);
    const config = Object.values(
      template.findResources("AWS::Lambda::EventInvokeConfig", {
        Properties: { MaximumRetryAttempts: 0 },
      }),
    );
    expect(config).toHaveLength(1);
  });

  it("grants the endpoint only what it calls, including starting the worker", () => {
    const st = statementsOf("TasksApiCallNotesFnServiceRoleDefaultPolicy");
    expect(actionsOn(st, "DataMessages")).toEqual([
      "dynamodb:BatchGetItem", // the hub's cards
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(actionsOn(st, "DataChannels")).toEqual(["dynamodb:GetItem"]);
    expect(actionsOn(st, "DataMeetingNotes")).toEqual(["dynamodb:PutItem", "dynamodb:Query"]);
    const invoke = st.filter((s) => [s.Action].flat().includes("lambda:InvokeFunction"));
    expect(invoke).toHaveLength(1);
    expect(JSON.stringify(invoke[0]?.Resource)).toMatch(/CallNotesWorkerFn/);
    expect(JSON.stringify(st)).not.toMatch(/bedrock/);
  });

  it("lets only the worker invoke the Haiku 5.5 profile and its model (standard runtime, not Mantle, nothing provisioned)", () => {
    const st = statementsOf("TasksApiCallNotesWorkerFnServiceRoleDefaultPolicy");
    const actions = st.flatMap((s) => [s.Action].flat());
    expect(actions).toContain("bedrock:InvokeModel");
    expect(actions).not.toContain("bedrock-mantle:CreateInference");
    const bedrock = st.find((s) => [s.Action].flat().includes("bedrock:InvokeModel"))!;
    const resources = JSON.stringify(bedrock.Resource);
    expect(resources).toMatch(/:inference-profile\/us\.anthropic\.claude-haiku-5-5/);
    expect(resources).toMatch(/arn:aws:bedrock:\*::foundation-model\/anthropic\.claude-haiku-5-5/);
    expect(resources).not.toContain('"*"');
    expect(actionsOn(st, "DataMessages")).toEqual(["dynamodb:UpdateItem"]);
    expect(actionsOn(st, "DataUsers")).toEqual(["dynamodb:GetItem"]);
    const types = Object.values(
      template.toJSON().Resources as Record<string, { Type: string }>,
    ).map((r) => r.Type);
    expect(types.some((t) => t.startsWith("AWS::Bedrock"))).toBe(false);
  });
});
