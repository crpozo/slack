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
      "DELETE /boards/{id}",
      "DELETE /push/subscribe",
      "DELETE /tasks/{taskId}",
      "GET /boards",
      "GET /boards/{id}/tasks",
      "GET /push/key",
      "POST /boards",
      "POST /boards/{id}/members",
      "POST /boards/{id}/tasks",
      "POST /push/subscribe",
      "PUT /boards/{id}",
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
      "dynamodb:BatchWriteItem", // a deleted board's membership rows
      "dynamodb:DeleteItem", // the board row itself
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(actionsOn("DataTasks")).toEqual([
      "dynamodb:BatchWriteItem", // a deleted board's tasks
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

describe("web push", () => {
  const statementsOf = (prefix: string) => {
    const policy = Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.startsWith(prefix),
    )?.[1];
    return (policy?.Properties?.PolicyDocument?.Statement ?? []) as Array<{
      Action: string | string[];
      Resource: unknown;
    }>;
  };

  it("stores subscriptions per user and device", () => {
    expect(
      matching("AWS::DynamoDB::Table", {
        TableName: "slack-dev-push-subscriptions",
        KeySchema: [
          { AttributeName: "userId", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    ).toHaveLength(1);
  });

  it("never puts VAPID keys in the template: Lambdas get the parameter's name only", () => {
    const json = template.toJSON() as { Parameters?: Record<string, unknown> };
    expect(JSON.stringify(json)).not.toMatch(/privateKey/);
    // No SSM resource nor deploy-time SSM lookup of the keys (only CDK's BootstrapVersion).
    expect(Object.keys(template.findResources("AWS::SSM::Parameter"))).toEqual([]);
    expect(Object.keys(json.Parameters ?? {})).toEqual(["BootstrapVersion"]);
    for (const name of ["slack-dev-push", "slack-dev-message"]) {
      expect(
        matching("AWS::Lambda::Function", {
          FunctionName: name,
          Environment: { Variables: Match.objectLike({ VAPID_PARAMETER: "/slack/dev/vapid" }) },
        }),
      ).toHaveLength(1);
    }
  });

  it("lets push and message read only this stage's VAPID parameter", () => {
    for (const prefix of ["TasksApiPushFnServiceRoleDefaultPolicy", "ApimessageFnServiceRole"]) {
      const ssm = statementsOf(prefix).filter((st) =>
        [st.Action].flat().some((a) => a.startsWith("ssm:")),
      );
      expect(ssm).toHaveLength(1);
      expect(ssm[0]?.Action).toBe("ssm:GetParameter");
      expect(JSON.stringify(ssm[0]?.Resource)).toContain(":parameter/slack/dev/vapid");
    }
  });

  it("gives the push Lambda only its own table", () => {
    const statements = statementsOf("TasksApiPushFnServiceRoleDefaultPolicy");
    const dynamo = statements.filter((st) =>
      [st.Action].flat().some((a) => a.startsWith("dynamodb:")),
    );
    expect(
      dynamo.every((st) => JSON.stringify(st.Resource).includes("DataPushSubscriptions")),
    ).toBe(true);
    expect(dynamo.flatMap((st) => [st.Action].flat()).sort()).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:PutItem",
    ]);
  });
});
