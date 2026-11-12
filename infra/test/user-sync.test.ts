import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

const synth = (context: Record<string, unknown> = {}) => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com", ...context },
  });
  const stack = new SlackStack(app, "TestUserSync", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  return Template.fromStack(stack);
};

let template: Template;
beforeAll(() => {
  template = synth();
}, 60_000);

describe("Cognito → users sync", () => {
  it("routes this pool's successful AdminDeleteUser calls (via CloudTrail) to user-cleanup", () => {
    const rules = template.findResources("AWS::Events::Rule", {
      Properties: { Name: "slack-dev-cognito-admin-delete-user" },
    });
    expect(Object.keys(rules)).toHaveLength(1);
    template.hasResourceProperties("AWS::Events::Rule", {
      Name: "slack-dev-cognito-admin-delete-user",
      EventPattern: {
        source: ["aws.cognito-idp"],
        "detail-type": ["AWS API Call via CloudTrail"],
        detail: {
          eventSource: ["cognito-idp.amazonaws.com"],
          eventName: ["AdminDeleteUser"],
          requestParameters: { userPoolId: [{ Ref: Match.stringLikeRegexp("UserPool") }] },
          errorCode: [{ exists: false }],
        },
      },
      Targets: [
        Match.objectLike({ Arn: { "Fn::GetAtt": [Match.stringLikeRegexp("UserCleanup"), "Arn"] } }),
      ],
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "slack-dev-user-cleanup",
      Environment: {
        Variables: Match.objectLike({
          USERS_TABLE: Match.anyValue(),
          USER_POOL_ID: Match.anyValue(),
        }),
      },
    });
  });

  it("lets user-cleanup delete and scan users and list the pool, and the channel Lambda list it", () => {
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const statementsOf = (role: RegExp) =>
      policies
        .filter((p) => JSON.stringify(p.Properties.Roles).match(role))
        .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<{ Action: unknown }>);
    const cleanup = JSON.stringify(statementsOf(/UserCleanup/));
    expect(cleanup).toContain("dynamodb:DeleteItem");
    expect(cleanup).toContain("dynamodb:Scan");
    expect(cleanup).toContain("cognito-idp:ListUsers");
    expect(JSON.stringify(statementsOf(/channelFn/))).toContain("cognito-idp:ListUsers");
  });

  it("creates a trail only when asked (-c cognitoTrail=true)", () => {
    expect(Object.keys(template.findResources("AWS::CloudTrail::Trail"))).toHaveLength(0);
    synth({ cognitoTrail: "true" }).hasResourceProperties("AWS::CloudTrail::Trail", {
      TrailName: "slack-dev-management-events",
      IsLogging: true,
      EventSelectors: [
        Match.objectLike({ IncludeManagementEvents: true, ReadWriteType: "WriteOnly" }),
      ],
    });
  }, 60_000);
});
