import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestTasks", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

const matching = (type: string, props: Record<string, unknown>) =>
  Object.keys(template.findResources(type, { Properties: props }));

describe("task manager API", () => {
  it("creates the boards and tasks tables with their query indexes", () => {
    expect(
      matching("AWS::DynamoDB::Table", {
        TableName: "slack-dev-boards",
        KeySchema: [
          { AttributeName: "boardId", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: "byUser",
            KeySchema: [
              { AttributeName: "userId", KeyType: "HASH" },
              { AttributeName: "boardId", KeyType: "RANGE" },
            ],
          }),
        ],
      }),
    ).toHaveLength(1);
    expect(
      matching("AWS::DynamoDB::Table", {
        TableName: "slack-dev-tasks",
        KeySchema: [{ AttributeName: "taskId", KeyType: "HASH" }],
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: "byBoard",
            KeySchema: [
              { AttributeName: "boardId", KeyType: "HASH" },
              { AttributeName: "createdAt", KeyType: "RANGE" },
            ],
          }),
        ],
      }),
    ).toHaveLength(1);
  });

  it("is an HTTP API whose every route sits behind the Cognito JWT authorizer", () => {
    const [apiId] = matching("AWS::ApiGatewayV2::Api", {
      Name: "slack-dev-tasks",
      ProtocolType: "HTTP",
    });
    expect(apiId).toBeDefined();
    expect(
      matching("AWS::ApiGatewayV2::Authorizer", {
        AuthorizerType: "JWT",
        IdentitySource: ["$request.header.Authorization"],
        JwtConfiguration: {
          Audience: [{ Ref: Match.stringLikeRegexp("AuthUserPoolWebClient") }],
          Issuer: {
            "Fn::Join": [
              "",
              [
                "https://cognito-idp.us-east-1.amazonaws.com/",
                { Ref: Match.stringLikeRegexp("AuthUserPool") },
              ],
            ],
          },
        },
      }),
    ).toHaveLength(1);

    const routes = Object.values(
      template.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { ApiId: { Ref: apiId } },
      }),
    ).map((r) => r.Properties as { RouteKey: string; AuthorizationType?: string });
    expect(routes.map((r) => r.RouteKey).sort((a, b) => a.localeCompare(b))).toEqual([
      "DELETE /tasks/{taskId}",
      "GET /boards",
      "GET /boards/{id}/tasks",
      "POST /boards",
      "POST /boards/{id}/members",
      "POST /boards/{id}/tasks",
      "PUT /tasks/{taskId}",
    ]);
    expect(routes.every((r) => r.AuthorizationType === "JWT")).toBe(true);
  });

  it("allows only the app's origins, local dev and the CloudFront domain", () => {
    const [api] = Object.values(
      template.findResources("AWS::ApiGatewayV2::Api", { Properties: { Name: "slack-dev-tasks" } }),
    );
    const cors = api?.Properties?.CorsConfiguration as {
      AllowOrigins: unknown[];
      AllowMethods: string[];
      AllowHeaders: string[];
    };
    expect(cors.AllowOrigins).toHaveLength(3);
    expect(cors.AllowOrigins.slice(0, 2)).toEqual([
      "http://localhost:5173",
      "http://localhost:4173",
    ]);
    expect(JSON.stringify(cors.AllowOrigins[2])).toMatch(/https:\/\/.*DomainName/); // CloudFront
    expect(cors.AllowMethods).toEqual(["GET", "POST", "PUT", "DELETE", "OPTIONS"]);
    expect(cors.AllowHeaders).toEqual(["authorization", "content-type"]);
  });

  it("grants the tasks Lambda only what the handler calls", () => {
    const policy = Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.startsWith("TasksApiFnServiceRoleDefaultPolicy"),
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
    expect(actionsOn("DataBoards")).toEqual([
      "dynamodb:BatchGetItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(actionsOn("DataTasks")).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(actionsOn("DataUsers")).toEqual(["dynamodb:BatchGetItem"]);
    expect(actionsOn("DataMessages")).toEqual([]);
    // Real-time pushes over the chat WebSocket: list members' connections, drop stale ones, post.
    expect(actionsOn("DataConnections")).toEqual(["dynamodb:DeleteItem", "dynamodb:Scan"]);
    expect(
      statements.some((st) => [st.Action].flat().includes("execute-api:ManageConnections")),
    ).toBe(true);
  });

  it("writes the API URL into config.json and outputs it", () => {
    const [entry] = Object.values(
      template.findResources("Custom::CDKBucketDeployment", {
        Properties: { Include: ["index.html", "config.json"] },
      }),
    );
    expect(JSON.stringify(entry?.Properties?.SourceMarkers)).toMatch(/TasksApiHttpApi/);
    expect(template.findOutputs("TasksApiUrl")).not.toEqual({});
  });
});
