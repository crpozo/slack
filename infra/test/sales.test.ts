import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";
import { SALES_ROUTES } from "../lib/tasks-api";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestSales", {
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

describe("Ventas (Phase 73)", () => {
  it("keeps its rows in its own table, a partition per organization", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "slack-dev-sales",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    });
  });

  it("serves every route behind the JWT authorizer from the sales Lambda", () => {
    expect(SALES_ROUTES).toHaveLength(7);
    for (const { method, path } of SALES_ROUTES) {
      const key = `${method} ${path}`;
      const route = Object.values(
        template.findResources("AWS::ApiGatewayV2::Route", { Properties: { RouteKey: key } }),
      )[0]?.Properties as { AuthorizationType: string; Target: unknown };
      expect([key, route.AuthorizationType]).toEqual([key, "JWT"]);
      expect(JSON.stringify(route.Target)).toMatch(/SalesIntegration/);
    }
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "slack-dev-sales",
      Timeout: 29,
    });
  });

  it("reaches only its table, the team's names and the model", () => {
    const statements = statementsOf("TasksApiSalesFnServiceRole");
    expect(actionsOn(statements, "DataSales")).toEqual([
      "dynamodb:BatchWriteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]);
    expect(actionsOn(statements, "DataUsers")).toEqual(["dynamodb:GetItem", "dynamodb:Scan"]);
    const others = statements
      .flatMap((st) => [st.Action].flat())
      .filter((a) => !a.startsWith("dynamodb:"));
    expect(others).toEqual(["bedrock:InvokeModel"]);
    // Phase 75: the project channels and their hours, read-only.
    expect(actionsOn(statements, "DataChannels")).toEqual(["dynamodb:Scan"]);
    expect(actionsOn(statements, "DataTimeLog")).toEqual(["dynamodb:Scan"]);
    expect(JSON.stringify(statements)).not.toMatch(/DataMessages|DataVault/);
  });
});
