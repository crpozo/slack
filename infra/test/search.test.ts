import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestSearch", {
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

describe("message search (Phase 42)", () => {
  it("streams the messages table (old and new images) and keeps the index in its own table", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "slack-dev-messages",
      StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "slack-dev-message-search",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "channelId", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    });
  });

  it("feeds the stream to the indexer, which may only write the index", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionName: Match.anyValue(),
      EventSourceArn: { "Fn::GetAtt": [Match.stringLikeRegexp("DataMessages"), "StreamArn"] },
      StartingPosition: "LATEST",
      BatchSize: 100,
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 5,
    });
    const indexer = statementsOf("TasksApiSearchIndexerFnServiceRoleDefaultPolicy");
    expect(actionsOn(indexer, "DataMessageSearch")).toEqual(["dynamodb:BatchWriteItem"]);
    expect(JSON.stringify(indexer)).toMatch(/dynamodb:GetRecords/);
    expect(JSON.stringify(indexer)).not.toMatch(/DataChannels|s3:|bedrock/);
    const [, worker] = fn("slack-dev-search-indexer")!;
    expect(Object.keys(worker.Properties.Environment.Variables).sort()).toEqual([
      "LOG_LEVEL",
      "MESSAGE_SEARCH_TABLE",
      "STAGE",
    ]);
  });

  it("serves GET /search behind the JWT authorizer, reading only what a search needs", () => {
    const route = Object.values(
      template.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: "GET /search" },
      }),
    )[0]?.Properties as { AuthorizationType: string; Target: unknown };
    expect(route.AuthorizationType).toBe("JWT");
    expect(JSON.stringify(route.Target)).toMatch(/SearchIntegration/);
    const search = statementsOf("TasksApiSearchFnServiceRoleDefaultPolicy");
    expect(actionsOn(search, "DataChannels")).toEqual(["dynamodb:Scan"]);
    expect(actionsOn(search, "DataMessageSearch")).toEqual(["dynamodb:Query"]);
    expect(actionsOn(search, "DataMessages")).toEqual(["dynamodb:BatchGetItem"]);
  });
});
