import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestSkills", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

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

describe("AI Skills (Phase 44)", () => {
  it("keeps the catalog in its own table: skillId + meta / file#<path>", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "slack-dev-skills",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "skillId", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    });
  });

  it("serves every route behind the JWT authorizer from the skills Lambda", () => {
    for (const key of [
      "GET /skills",
      "POST /skills",
      "GET /skills/{id}",
      "DELETE /skills/{id}",
      "GET /skills/{id}/download",
      "POST /skills/import-github",
      "POST /skills/generate",
    ]) {
      const route = Object.values(
        template.findResources("AWS::ApiGatewayV2::Route", { Properties: { RouteKey: key } }),
      )[0]?.Properties as { AuthorizationType: string; Target: unknown };
      expect([key, route.AuthorizationType]).toEqual([key, "JWT"]);
      expect(JSON.stringify(route.Target)).toMatch(/SkillsIntegration/);
    }
    const fn = Object.values(
      template.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "slack-dev-skills" },
      }),
    )[0]?.Properties as { Timeout: number; Environment: { Variables: Record<string, unknown> } };
    // GitHub and the model each answer within API Gateway's 30 s.
    expect(fn.Timeout).toBe(30);
    expect(Object.keys(fn.Environment.Variables).sort()).toEqual([
      "GITHUB_TOKEN_PARAMETER",
      "LOG_LEVEL",
      "SKILLS_TABLE",
      "STAGE",
      "USERS_TABLE",
    ]);
    expect(fn.Environment.Variables.GITHUB_TOKEN_PARAMETER).toBe("/slack/dev/github-token");
  });

  it("grants the skills Lambda the catalog, the author's name, the optional token and the model, nothing else", () => {
    const st = statementsOf("TasksApiSkillsFnServiceRoleDefaultPolicy");
    expect(actionsOn(st, "DataSkills")).toEqual([
      "dynamodb:BatchWriteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ]);
    expect(actionsOn(st, "DataUsers")).toEqual(["dynamodb:GetItem"]);
    const ssm = st.filter((s) => [s.Action].flat().some((a) => a.startsWith("ssm:")));
    expect(ssm).toHaveLength(1);
    expect(JSON.stringify(ssm[0]?.Resource)).toContain(":parameter/slack/dev/github-token");
    const bedrock = st.filter((s) => JSON.stringify(s.Action).includes("bedrock"));
    expect(bedrock.flatMap((s) => [s.Action].flat())).toEqual(["bedrock:InvokeModel"]);
    expect(JSON.stringify(bedrock[0]?.Resource)).toMatch(
      /inference-profile\/us\.anthropic\.claude-haiku-5-5/,
    );
    expect(JSON.stringify(st)).not.toMatch(/s3:|DataMessages|DataChannels/);
  });
});
