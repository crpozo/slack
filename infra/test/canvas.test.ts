import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestCanvas", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

describe("channel canvas", () => {
  it("creates the canvases table, keyed by channel", () => {
    expect(
      Object.keys(
        template.findResources("AWS::DynamoDB::Table", {
          Properties: {
            TableName: "slack-dev-canvases",
            KeySchema: [{ AttributeName: "channelId", KeyType: "HASH" }],
            BillingMode: "PAY_PER_REQUEST",
          },
        }),
      ),
    ).toHaveLength(1);
  });

  it("serves the canvas routes from its own Lambda on the HTTP API", () => {
    const [fn] = Object.values(
      template.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "slack-dev-canvas" },
      }),
    );
    expect(fn).toBeDefined();
    const env = fn?.Properties.Environment.Variables as Record<string, unknown>;
    expect(Object.keys(env).sort()).toEqual([
      "CANVASES_TABLE",
      "CHANNELS_TABLE",
      "CONNECTIONS_TABLE",
      "LOG_LEVEL",
      "STAGE",
      "WS_ENDPOINT",
    ]);
    const routes = Object.values(
      template.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: Match.stringLikeRegexp("/canvas$") },
      }),
    ).map((r) => r.Properties as { RouteKey: string; Target: unknown; AuthorizationType: string });
    expect(routes.map((r) => r.RouteKey).sort()).toEqual([
      "GET /channels/{id}/canvas",
      "PUT /channels/{id}/canvas",
    ]);
    expect(routes.every((r) => r.AuthorizationType === "JWT")).toBe(true);
    expect(JSON.stringify(routes[0]?.Target)).toMatch(/CanvasIntegration/);
  });

  it("grants the canvas Lambda only what its handler calls", () => {
    const policy = Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.startsWith("TasksApiCanvasFnServiceRoleDefaultPolicy"),
    )?.[1];
    const statements = (policy?.Properties?.PolicyDocument?.Statement ?? []) as Array<{
      Action: string | string[];
      Resource: unknown;
    }>;
    const actionsOn = (table: string) =>
      statements
        .filter((st) => JSON.stringify(st.Resource).includes(`"${table}`))
        .flatMap((st) => [st.Action].flat())
        .sort((a, b) => a.localeCompare(b));
    expect(actionsOn("DataCanvases")).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
    expect(actionsOn("DataChannels")).toEqual(["dynamodb:GetItem"]);
    expect(actionsOn("DataConnections")).toEqual(["dynamodb:DeleteItem", "dynamodb:Scan"]);
    expect(actionsOn("DataMessages")).toEqual([]);
  });

  it("lets the channel Lambda drop a deleted channel's canvas", () => {
    const policy = Object.entries(template.findResources("AWS::IAM::Policy")).find(
      ([id]) => id.includes("channel") && id.includes("ServiceRoleDefaultPolicy"),
    )?.[1];
    const statements = (policy?.Properties?.PolicyDocument?.Statement ?? []) as Array<{
      Action: string | string[];
      Resource: unknown;
    }>;
    const onCanvases = statements
      .filter((st) => JSON.stringify(st.Resource).includes('"DataCanvases'))
      .flatMap((st) => [st.Action].flat());
    expect(onCanvases).toEqual(["dynamodb:DeleteItem"]);
  });
});
