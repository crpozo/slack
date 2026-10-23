import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestCalendar", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

const matching = (type: string, props: Record<string, unknown>) =>
  Object.keys(template.findResources(type, { Properties: props }));

describe("company calendar", () => {
  it("creates the events table (by id, indexed by year) and the vacation ledger", () => {
    expect(
      matching("AWS::DynamoDB::Table", {
        TableName: "slack-dev-events",
        KeySchema: [{ AttributeName: "eventId", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: "byYear",
            KeySchema: [
              { AttributeName: "year", KeyType: "HASH" },
              { AttributeName: "startAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          }),
        ],
      }),
    ).toHaveLength(1);
    expect(
      matching("AWS::DynamoDB::Table", {
        TableName: "slack-dev-vacation-balances",
        KeySchema: [
          { AttributeName: "userId", KeyType: "HASH" },
          { AttributeName: "year", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: "byYear",
            KeySchema: [
              { AttributeName: "year", KeyType: "HASH" },
              { AttributeName: "userId", KeyType: "RANGE" },
            ],
          }),
        ],
      }),
    ).toHaveLength(1);
  });

  it("serves the calendar routes from its own Lambda on the tasks HTTP API", () => {
    const [fn] = Object.values(
      template.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "slack-dev-calendar" },
      }),
    );
    expect(fn).toBeDefined();
    const env = fn?.Properties.Environment.Variables as Record<string, unknown>;
    expect(Object.keys(env).sort()).toEqual([
      "CHANNELS_TABLE",
      "CONNECTIONS_TABLE",
      "EVENTS_TABLE",
      "LOG_LEVEL",
      "MESSAGES_TABLE",
      "PUSH_SUBSCRIPTIONS_TABLE",
      "STAGE",
      "USERS_TABLE",
      "USER_POOL_ID",
      "VACATION_BALANCES_TABLE",
      "VAPID_PARAMETER",
      "WS_ENDPOINT",
    ]);
    const routes = Object.values(
      template.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: Match.stringLikeRegexp("/calendar/") },
      }),
    ).map((r) => r.Properties as { RouteKey: string; Target: unknown; AuthorizationType: string });
    expect(routes).toHaveLength(7);
    expect(routes.every((r) => r.AuthorizationType === "JWT")).toBe(true);
    // All on the calendar integration, never the tasks one.
    const targets = new Set(routes.map((r) => JSON.stringify(r.Target)));
    expect(targets.size).toBe(1);
    expect([...targets][0]).toMatch(/CalendarIntegration/);
  });

  it("grants the calendar Lambda only what its handler calls", () => {
    const policy = Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.startsWith("TasksApiCalendarFnServiceRoleDefaultPolicy"),
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
    expect(actionsOn("DataEvents")).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(actionsOn("DataVacationBalances")).toEqual([
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(actionsOn("DataUsers")).toEqual(["dynamodb:BatchGetItem", "dynamodb:GetItem"]);
    expect(actionsOn("DataBoards")).toEqual([]);
    expect(actionsOn("DataTasks")).toEqual([]);
    // DM meetings: the conversation row, and the card written with the event (retries find it).
    // Phase 34: invitees' DMs opened for their cards (PutItem) and bumped (UpdateItem).
    expect(actionsOn("DataChannels")).toEqual([
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]);
    expect(actionsOn("DataMessages")).toEqual([
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(actionsOn("DataConnections")).toEqual(["dynamodb:DeleteItem", "dynamodb:Scan"]);
    expect(actionsOn("DataPushSubscriptions")).toEqual(["dynamodb:DeleteItem", "dynamodb:Query"]);
    expect(
      statements.some((st) => [st.Action].flat().includes("execute-api:ManageConnections")),
    ).toBe(true);
    // Only the admins group listing, nothing that creates or changes accounts.
    const cognito = statements.filter((st) =>
      [st.Action].flat().some((a) => a.startsWith("cognito-idp:")),
    );
    expect(cognito.map((st) => [st.Action].flat()).flat()).toEqual([
      "cognito-idp:ListUsersInGroup",
    ]);
  });
});
