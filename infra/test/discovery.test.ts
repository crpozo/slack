import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { userPoolIdParameterName } from "@mindfultech/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { LAMBDA_MEMORY_MB } from "../lib/lambda";
import { SlackStack } from "../lib/slack-stack";

// Phase 68: what Discovery (another repo, same User Pool) needs from this stack.

const STAGES = ["dev", "prod"] as const;
const templates = new Map<(typeof STAGES)[number], Template>();

beforeAll(() => {
  for (const stage of STAGES) {
    const app = new App({
      context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
    });
    const stack = new SlackStack(app, `TestDiscovery${stage}`, {
      env: { account: "123456789012", region: "us-east-1" },
      stage,
    });
    templates.set(stage, Template.fromStack(stack));
  }
}, 120_000);

const poolRef = { Ref: Match.stringLikeRegexp("^AuthUserPool") };

describe.each(STAGES)("Discovery integration (%s)", (stage) => {
  const template = () => templates.get(stage)!;

  it("publishes the User Pool ID in SSM under /slack/<stage>/user-pool-id", () => {
    expect(userPoolIdParameterName(stage)).toBe(`/slack/${stage}/user-pool-id`);
    template().resourceCountIs("AWS::SSM::Parameter", 1);
    template().hasResourceProperties("AWS::SSM::Parameter", {
      Name: `/slack/${stage}/user-pool-id`,
      Type: "String",
      Value: poolRef,
    });
  });

  it("gives the pool a Custom message trigger, and keeps its own invitation template", () => {
    template().hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: {
        CustomMessage: {
          "Fn::GetAtt": [Match.stringLikeRegexp("^AuthCustomMessageFn"), "Arn"],
        },
      },
      AdminCreateUserConfig: Match.objectLike({
        InviteMessageTemplate: Match.objectLike({
          EmailSubject: "You're invited to collaborate with MindfulTech",
        }),
      }),
    });
    template().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: `slack-${stage}-cognito-custom-message`,
      Handler: "index.handler",
      MemorySize: LAMBDA_MEMORY_MB,
      Timeout: 5,
    });
    // Only Cognito, and only from this pool, may invoke it.
    template().hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      FunctionName: { "Fn::GetAtt": [Match.stringLikeRegexp("^AuthCustomMessageFn"), "Arn"] },
      Principal: "cognito-idp.amazonaws.com",
      SourceArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^AuthUserPool"), "Arn"] },
    });
  });

  it("gives the function no permissions beyond writing its logs", () => {
    const fns = template().findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: `slack-${stage}-cognito-custom-message` },
    });
    const [fn] = Object.values(fns);
    const roleId = (fn?.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    const role = template().findResources("AWS::IAM::Role")[roleId];
    expect(JSON.stringify(role?.Properties.ManagedPolicyArns)).toMatch(
      /service-role\/AWSLambdaBasicExecutionRole/,
    );
    expect(role?.Properties.Policies).toBeUndefined();
    const inline = Object.values(template().findResources("AWS::IAM::Policy")).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes(roleId),
    );
    expect(inline).toEqual([]);
    // Nothing in its environment either (it only rewrites the event).
    expect(fn?.Properties.Environment).toBeUndefined();
  });
});
