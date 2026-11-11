import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";
import { MESSAGES_ROUTES } from "../lib/tasks-api";

// Phase 61: the image gallery's sparse index on the messages table, and its route.
let template: Template;
beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestGallery", {
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

describe("the image gallery (Phase 61)", () => {
  it("indexes messages with images only: channelId + imageAt, projecting what the viewer shows", () => {
    const [table] = Object.values(
      template.findResources("AWS::DynamoDB::Table", {
        Properties: { TableName: "slack-dev-messages" },
      }),
    );
    const indexes = table!.Properties.GlobalSecondaryIndexes as Array<Record<string, unknown>>;
    expect(indexes).toEqual([
      {
        IndexName: "byImage",
        KeySchema: [
          { AttributeName: "channelId", KeyType: "HASH" },
          { AttributeName: "imageAt", KeyType: "RANGE" },
        ],
        Projection: {
          ProjectionType: "INCLUDE",
          NonKeyAttributes: ["messageId", "userId", "createdAt", "attachments"],
        },
      },
    ]);
    // The table keeps its own key and its stream (search) as they were.
    expect(table!.Properties.KeySchema).toEqual([
      { AttributeName: "channelId", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ]);
    expect(table!.Properties.StreamSpecification).toEqual({
      StreamViewType: "NEW_AND_OLD_IMAGES",
    });
  });

  it("serves GET /channels/{channelId}/media from the messages Lambda, behind the JWT", () => {
    expect(MESSAGES_ROUTES).toContainEqual({ method: "GET", path: "/channels/{channelId}/media" });
    const [route] = Object.values(
      template.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: "GET /channels/{channelId}/media" },
      }),
    );
    expect(route?.Properties.AuthorizationType).toBe("JWT");
  });

  it("the messages Lambda may Query the index (its ARN is covered by the table grant)", () => {
    const statements = statementsOf("TasksApiMessagesFnServiceRoleDefaultPolicy").filter(
      (st) =>
        [st.Action].flat().includes("dynamodb:Query") &&
        JSON.stringify(st.Resource).includes('"DataMessages'),
    );
    expect(JSON.stringify(statements)).toMatch(/\/index\/\*/);
  });
});
