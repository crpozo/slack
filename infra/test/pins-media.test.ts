import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

// Phase 38: the files/links/pins index table, the `pin` WebSocket route and who may touch what.
let template: Template;
beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestPins", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

type Statement = { Action: string | string[]; Resource: unknown };
const statementsOf = (prefix: string) =>
  (Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
    id.startsWith(prefix),
  )?.[1]?.Properties?.PolicyDocument?.Statement ?? []) as Statement[];
/** Actions on `table` (its logical id prefix, e.g. "DataChannelMedia"). */
const actionsOn = (statements: Statement[], table: string) =>
  [
    ...new Set(
      statements
        .filter((st) => JSON.stringify(st.Resource).includes(`"${table}`))
        .flatMap((st) => [st.Action].flat()),
    ),
  ].sort((a, b) => a.localeCompare(b));

describe("pins and files & links (Phase 38)", () => {
  it("creates the channel-media table: channelId + sk, on demand", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "slack-dev-channel-media",
      KeySchema: [
        { AttributeName: "channelId", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  it("routes the `pin` action to its own Lambda", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "pin" });
    template.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "slack-dev-pin" });
  });

  it("gives each WebSocket Lambda only what it does with the index", () => {
    const pin = statementsOf("ApipinFnServiceRoleDefaultPolicy");
    expect(actionsOn(pin, "DataChannelMedia")).toEqual(["dynamodb:DeleteItem", "dynamodb:PutItem"]);
    expect(actionsOn(pin, "DataMessages")).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
    expect(actionsOn(pin, "DataChannels")).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
    expect(
      actionsOn(statementsOf("ApimessageFnServiceRoleDefaultPolicy"), "DataChannelMedia"),
    ).toEqual(["dynamodb:PutItem"]);
    expect(
      actionsOn(statementsOf("ApieditFnServiceRoleDefaultPolicy"), "DataChannelMedia"),
    ).toEqual(["dynamodb:BatchWriteItem"]);
    expect(
      actionsOn(statementsOf("ApichannelFnServiceRoleDefaultPolicy"), "DataChannelMedia"),
    ).toEqual(["dynamodb:BatchWriteItem", "dynamodb:Query"]);
    // Nobody else touches it.
    expect(
      actionsOn(statementsOf("ApihistoryFnServiceRoleDefaultPolicy"), "DataChannelMedia"),
    ).toEqual([]);
    expect(
      actionsOn(statementsOf("ApireactFnServiceRoleDefaultPolicy"), "DataChannelMedia"),
    ).toEqual([]);
  });
});
