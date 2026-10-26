import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestNews", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

describe("AI News (Phase 35b)", () => {
  const lambda = () =>
    Object.entries(
      template.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "slack-dev-news" },
      }),
    )[0];

  it("serves GET /news behind the JWT authorizer from its own Lambda", () => {
    const route = Object.values(
      template.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: "GET /news" },
      }),
    )[0]?.Properties as { AuthorizationType: string; Target: unknown };
    expect(route.AuthorizationType).toBe("JWT");
    expect(JSON.stringify(route.Target)).toMatch(/NewsIntegration/);
    expect(lambda()?.[1].Properties).toMatchObject({
      Runtime: "nodejs22.x",
      Timeout: 10,
      Environment: { Variables: { STAGE: "dev", LOG_LEVEL: "info" } },
    });
  });

  it("has no data permissions at all: no table, bucket or parameter", () => {
    const [, fn] = lambda()!;
    const env = fn.Properties.Environment.Variables as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(["LOG_LEVEL", "STAGE"]);
    const roleRef = JSON.stringify(fn.Properties.Role);
    expect(roleRef).toMatch(/NewsFnServiceRole/);
    // Every inline policy attached to its role (there should be none).
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes(
        roleRef.match(/"(\w+ServiceRole\w*)"/)?.[1] ?? "?",
      ),
    );
    expect(policies).toEqual([]);
    // Only the basic execution role (CloudWatch Logs).
    const roleId = roleRef.match(/"(\w+ServiceRole\w*)"/)?.[1] ?? "";
    const role = template.findResources("AWS::IAM::Role")[roleId];
    expect(JSON.stringify(role?.Properties.ManagedPolicyArns)).toMatch(
      /AWSLambdaBasicExecutionRole/,
    );
    expect(JSON.stringify(role)).not.toMatch(/dynamodb|s3:|ssm:/i);
  });
});
