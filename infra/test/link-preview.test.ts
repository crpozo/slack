import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

// Phase 64: link previews: a small cache table, one Lambda, one route.
let template: Template;
beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestLinkPreview", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

describe("link previews (Phase 64)", () => {
  it("keeps previews by URL hash, expiring on their own", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "slack-dev-link-previews",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "urlKey", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
  });

  it("serves GET /utils/link-preview behind the JWT authorizer, 10 s at most", () => {
    const [route] = Object.values(
      template.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: "GET /utils/link-preview" },
      }),
    );
    expect(route?.Properties.AuthorizationType).toBe("JWT");
    expect(JSON.stringify(route?.Properties.Target)).toMatch(/LinkPreviewIntegration/);
    const [fn] = Object.values(
      template.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "slack-dev-link-preview" },
      }),
    );
    expect(fn!.Properties.Timeout).toBe(10);
    expect(Object.keys(fn!.Properties.Environment.Variables).sort()).toEqual([
      "LINK_PREVIEWS_TABLE",
      "LOG_LEVEL",
      "STAGE",
    ]);
  });

  it("may read and write its cache, and nothing else of ours", () => {
    const [, policy] = Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.startsWith("TasksApiLinkPreviewFnServiceRoleDefaultPolicy"),
    )!;
    const statements = policy.Properties.PolicyDocument.Statement as Array<{
      Action: string | string[];
      Resource: unknown;
    }>;
    expect(statements.flatMap((st) => [st.Action].flat()).sort()).toEqual([
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]);
    expect(JSON.stringify(statements)).toMatch(/DataLinkPreviews/);
  });
});
