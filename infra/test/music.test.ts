import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";
import { MUSIC_ROUTES } from "../lib/tasks-api";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestMusic", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

describe("Música (Phase 78)", () => {
  it("keeps the rooms in their own table", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "slack-dev-music",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "roomId", KeyType: "HASH" }],
    });
  });

  it("serves every route behind the JWT authorizer from the music Lambda", () => {
    expect(MUSIC_ROUTES).toHaveLength(6);
    for (const { method, path } of MUSIC_ROUTES) {
      const key = `${method} ${path}`;
      const route = Object.values(
        template.findResources("AWS::ApiGatewayV2::Route", { Properties: { RouteKey: key } }),
      )[0]?.Properties as { AuthorizationType: string; Target: unknown };
      expect([key, route.AuthorizationType]).toEqual([key, "JWT"]);
      expect(JSON.stringify(route.Target)).toMatch(/MusicIntegration/);
    }
  });

  it("reaches only its rooms, the caller's name and the connections it tells", () => {
    const statements = (Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.startsWith("TasksApiMusicFnServiceRole"),
    )?.[1]?.Properties?.PolicyDocument?.Statement ?? []) as Array<{
      Action: string | string[];
      Resource: unknown;
    }>;
    const on = (table: string) =>
      statements
        .filter((st) => JSON.stringify(st.Resource).includes(`"${table}`))
        .flatMap((st) => [st.Action].flat())
        .sort((a, b) => a.localeCompare(b));
    expect(on("DataMusic")).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Scan",
    ]);
    expect(on("DataUsers")).toEqual(["dynamodb:GetItem"]);
    expect(JSON.stringify(statements)).not.toMatch(/DataMessages|DataVault|DataSales|bedrock/);
  });
});
