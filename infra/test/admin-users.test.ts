import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";
import { ADMIN_ROUTES } from "../lib/tasks-api";

// Phase 62: the team panel's Lambda, its routes and exactly what it may do.
let template: Template;
beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestAdmin", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

type Statement = { Action: string | string[]; Resource: unknown };
const statements = () =>
  (Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
    id.startsWith("TasksApiAdminUsersFnServiceRoleDefaultPolicy"),
  )?.[1]?.Properties?.PolicyDocument?.Statement ?? []) as Statement[];

describe("the team panel (Phase 62)", () => {
  it("serves /admin/users behind the JWT authorizer from its own Lambda", () => {
    for (const { method, path } of ADMIN_ROUTES) {
      const [route] = Object.values(
        template.findResources("AWS::ApiGatewayV2::Route", {
          Properties: { RouteKey: `${method} ${path}` },
        }),
      );
      expect(route?.Properties.AuthorizationType, `${method} ${path}`).toBe("JWT");
      expect(JSON.stringify(route?.Properties.Target)).toMatch(/AdminUsersIntegration/);
    }
    const [fn] = Object.values(
      template.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "slack-dev-admin-users" },
      }),
    );
    expect(Object.keys(fn!.Properties.Environment.Variables).sort()).toEqual([
      "LOG_LEVEL",
      "STAGE",
      "USERS_TABLE",
      "USER_POOL_ID",
    ]);
  });

  it("may manage accounts in this pool and write profiles, nothing else", () => {
    const all = statements();
    const cognito = all.filter((st) => JSON.stringify(st.Action).includes("cognito-idp"));
    expect(cognito.flatMap((st) => [st.Action].flat()).sort()).toEqual([
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:ListUsers",
      "cognito-idp:ListUsersInGroup",
    ]);
    expect(JSON.stringify(cognito)).toMatch(/AuthUserPool/);
    const dynamo = all
      .filter((st) => JSON.stringify(st.Resource).includes("DataUsers"))
      .flatMap((st) => [st.Action].flat())
      .sort();
    expect(dynamo).toEqual(["dynamodb:PutItem", "dynamodb:Scan", "dynamodb:UpdateItem"]);
    expect(JSON.stringify(all)).not.toMatch(/DataMessages|DataChannels/);
  });
});
