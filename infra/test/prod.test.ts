import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { isEmail } from "../lib/cost";
import { SlackStack } from "../lib/slack-stack";

const CERT = "arn:aws:acm:us-east-1:123456789012:certificate/abc-123";

function synth(stage: "dev" | "prod", context: Record<string, string> = {}): Template {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com", ...context },
  });
  const stack = new SlackStack(app, `Test${stage}`, {
    env: { account: "123456789012", region: "us-east-1" },
    stage,
  });
  return Template.fromStack(stack);
}

/** Logical ids of the `type` resources whose properties match `props` (as `hasResourceProperties`). */
function matching(template: Template, type: string, props: Record<string, unknown>): string[] {
  return Object.keys(template.findResources(type, { Properties: props }));
}

function count(template: Template, type: string): number {
  return Object.keys(template.findResources(type)).length;
}

function outputValue(template: Template, name: string): unknown {
  return template.findOutputs(name)[name]?.Value;
}

describe("attachments CORS", () => {
  it("only allows the app origins and localhost", () => {
    const template = synth("prod");
    const buckets = matching(template, "AWS::S3::Bucket", {
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedMethods: ["PUT", "GET"],
            AllowedOrigins: [
              {
                "Fn::Join": ["", ["https://", { "Fn::GetAtt": [Match.anyValue(), "DomainName"] }]],
              },
              "https://slack.mindfultech.ec",
              "https://ws.mindfultech.ec",
              "http://localhost:5173",
              "http://localhost:4173",
            ],
          }),
        ],
      },
    });
    expect(buckets).toHaveLength(1);
  });

  it("has no wildcard origin in dev either", () => {
    const json = JSON.stringify(synth("dev").findResources("AWS::S3::Bucket"));
    expect(json).toContain("http://localhost:5173");
    expect(json).not.toContain('"AllowedOrigins":["*"]');
  });
});

describe("custom domains", () => {
  it("stay off until a certificate is provided", () => {
    const template = synth("prod");
    expect(count(template, "AWS::ApiGatewayV2::DomainName")).toBe(0);
    expect(count(template, "AWS::Route53::RecordSet")).toBe(0);
    expect(
      matching(template, "AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({ Aliases: Match.absent() }),
      }),
    ).toHaveLength(1);
    expect(outputValue(template, "WebSocketUrl")).not.toContain("mindfultech.ec");
  });

  it("wire CloudFront, the WebSocket API and config.json to the domains", () => {
    const template = synth("prod", { certificateArn: CERT });

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["slack.mindfultech.ec"],
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: CERT }),
      }),
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
      DomainName: "ws.mindfultech.ec",
      DomainNameConfigurations: [Match.objectLike({ CertificateArn: CERT })],
    });
    template.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 1);
    template.hasOutput("WebSocketUrl", { Value: "wss://ws.mindfultech.ec" });
    template.hasOutput("AppUrl", { Value: "https://slack.mindfultech.ec" });
    template.hasOutput("WsDnsTarget", {});
    template.resourceCountIs("AWS::Route53::RecordSet", 0);

    const markers = JSON.stringify(
      template.findResources("Custom::CDKBucketDeployment", {
        Properties: { Include: ["index.html", "config.json"] },
      }),
    );
    // A literal URL is written into the config.json asset itself, so the
    // deploy-time markers no longer point at the execute-api hostname.
    expect(markers).not.toContain("execute-api");
  });

  it("create Route 53 alias records when a hosted zone id is given", () => {
    const template = synth("prod", { certificateArn: CERT, hostedZoneId: "Z123" });
    expect(count(template, "AWS::Route53::RecordSet")).toBe(2);
    for (const name of ["slack.mindfultech.ec.", "ws.mindfultech.ec."]) {
      expect(
        matching(template, "AWS::Route53::RecordSet", {
          Name: name,
          Type: "A",
          HostedZoneId: "Z123",
        }),
      ).toHaveLength(1);
    }
  });
});

describe("cost alerts", () => {
  it("monitors anomalies on the project=slack tag and emails daily in prod", () => {
    const template = synth("prod");
    expect(
      matching(template, "AWS::CE::AnomalyMonitor", {
        MonitorType: "CUSTOM",
        MonitorSpecification: Match.serializedJson({
          Tags: { Key: "project", Values: ["slack"], MatchOptions: ["EQUALS"] },
        }),
      }),
    ).toHaveLength(1);
    expect(
      matching(template, "AWS::CE::AnomalySubscription", {
        Frequency: "DAILY",
        Subscribers: [{ Type: "EMAIL", Address: "alerts@example.com" }],
      }),
    ).toHaveLength(1);
    expect(count(template, "AWS::Budgets::Budget")).toBe(1);
  });

  it("refuse to synthesize prod without a valid budgetEmail", () => {
    expect(() => synth("prod", { budgetEmail: "" })).toThrow('CDK context "budgetEmail"');
    expect(() => synth("prod", { budgetEmail: "not-an-email" })).toThrow("budgetEmail");
  });

  it("validate budgetEmail like the previous /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/ pattern", () => {
    const valid = ["a@b.co", "alerts@example.com", "x@a.b.", "first.last@sub.domain.ec"];
    const invalid = [
      "",
      "a@b",
      "@b.co",
      "a@.co",
      "a@b.",
      "a@@b.co",
      "a@b@c.co",
      "a b@c.co",
      "a@b.c o",
    ];
    for (const value of valid) expect(isEmail(value), value).toBe(true);
    for (const value of invalid) expect(isEmail(value), value).toBe(false);
  });

  it("output the anomaly monitor ARN in prod", () => {
    const template = synth("prod");
    const [monitorId] = matching(template, "AWS::CE::AnomalyMonitor", {});
    expect(outputValue(template, "CostAnomalyMonitorArn")).toEqual({
      "Fn::GetAtt": [monitorId, "MonitorArn"],
    });
  });

  it("are not created in dev", () => {
    const template = synth("dev");
    expect(count(template, "AWS::CE::AnomalyMonitor")).toBe(0);
    expect(count(template, "AWS::CE::AnomalySubscription")).toBe(0);
    expect(count(template, "AWS::Budgets::Budget")).toBe(0);
    expect(template.findOutputs("CostAnomalyMonitorArn")).toEqual({});
  });
});

describe("GitHub deploy role", () => {
  it("trusts only main of crpozo/slack via OIDC and can only assume CDK roles", () => {
    const template = synth("prod");
    const roles = matching(template, "AWS::IAM::Role", {
      RoleName: "slack-github-deploy",
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub": "repo:crpozo/slack:ref:refs/heads/main",
              },
            },
          }),
        ],
      },
    });
    expect(roles).toHaveLength(1);
    const policies = matching(template, "AWS::IAM::Policy", {
      Roles: [{ Ref: roles[0] }],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRole",
            Resource: {
              "Fn::Join": [
                "",
                ["arn:", { Ref: "AWS::Partition" }, ":iam::123456789012:role/cdk-*"],
              ],
            },
          }),
        ]),
      },
    });
    expect(policies).toHaveLength(1);
    expect(outputValue(template, "GitHubDeployRoleArn")).toEqual({
      "Fn::GetAtt": [roles[0], "Arn"],
    });
  });

  it("reuses an existing OIDC provider when its ARN is given", () => {
    const template = synth("prod", {
      githubOidcProviderArn:
        "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
    });
    expect(count(template, "Custom::AWSCDKOpenIdConnectProvider")).toBe(0);
    expect(matching(template, "AWS::IAM::Role", { RoleName: "slack-github-deploy" })).toHaveLength(
      1,
    );
  });

  it("does not exist in dev", () => {
    const template = synth("dev");
    expect(count(template, "Custom::AWSCDKOpenIdConnectProvider")).toBe(0);
    expect(matching(template, "AWS::IAM::Role", { RoleName: "slack-github-deploy" })).toEqual([]);
    expect(template.findOutputs("GitHubDeployRoleArn")).toEqual({});
  });
});

describe("phase 5.1 resources", () => {
  const template = () => synth("dev");

  it("adds the users table", () => {
    expect(
      matching(template(), "AWS::DynamoDB::Table", {
        TableName: "slack-dev-users",
        KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    ).toHaveLength(1);
  });

  it("routes the user and react actions to their own Lambdas", () => {
    const t = template();
    for (const routeKey of ["user", "react"]) {
      expect(matching(t, "AWS::ApiGatewayV2::Route", { RouteKey: routeKey })).toHaveLength(1);
    }
    for (const name of ["slack-dev-user", "slack-dev-react"]) {
      expect(
        matching(t, "AWS::Lambda::Function", {
          FunctionName: name,
          Runtime: "nodejs22.x",
          Environment: { Variables: Match.objectLike({ USERS_TABLE: Match.anyValue() }) },
        }),
      ).toHaveLength(1);
    }
  });

  it("grants only the DynamoDB actions each new path needs", () => {
    const t = template();
    /** Actions of `fn`'s role on the table whose logical id starts with `table`. */
    const actionsOn = (fn: string, table: string): string[] => {
      const policy = Object.entries(t.findResources("AWS::IAM::Policy")).find(([id]) =>
        id.startsWith(`Api${fn}FnServiceRoleDefaultPolicy`),
      )?.[1];
      const statements = (policy?.Properties?.PolicyDocument?.Statement ?? []) as Array<{
        Action: string | string[];
        Resource: unknown;
      }>;
      return statements
        .filter((st) => JSON.stringify(st.Resource).includes(`"${table}`))
        .flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]))
        .sort((a, b) => a.localeCompare(b));
    };

    expect(actionsOn("connect", "DataUsers")).toEqual(["dynamodb:UpdateItem"]);
    expect(actionsOn("user", "DataUsers")).toEqual(["dynamodb:Scan", "dynamodb:UpdateItem"]);
    expect(actionsOn("channel", "DataUsers")).toEqual(["dynamodb:BatchGetItem"]);
    expect(actionsOn("react", "DataMessages")).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
    expect(actionsOn("react", "DataChannels")).toEqual(["dynamodb:GetItem"]);
    expect(actionsOn("history", "DataChannels")).toEqual(["dynamodb:GetItem"]);
    expect(actionsOn("message", "DataUsers")).toEqual([]);
  });

  it("routes ping to a no-op Lambda with no DynamoDB or @connections permissions", () => {
    const t = template();
    expect(matching(t, "AWS::ApiGatewayV2::Route", { RouteKey: "ping" })).toHaveLength(1);
    expect(
      matching(t, "AWS::Lambda::Function", {
        FunctionName: "slack-dev-ping",
        Runtime: "nodejs22.x",
      }),
    ).toHaveLength(1);
    const policies = Object.keys(t.findResources("AWS::IAM::Policy")).filter((id) =>
      id.startsWith("ApipingFnServiceRoleDefaultPolicy"),
    );
    expect(policies).toEqual([]);
  });

  it("routes call signaling to a Lambda that only touches connections", () => {
    const t = template();
    expect(matching(t, "AWS::ApiGatewayV2::Route", { RouteKey: "call" })).toHaveLength(1);
    expect(
      matching(t, "AWS::Lambda::Function", {
        FunctionName: "slack-dev-call",
        Runtime: "nodejs22.x",
      }),
    ).toHaveLength(1);

    const policy = Object.entries(t.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.startsWith("ApicallFnServiceRoleDefaultPolicy"),
    )?.[1];
    const statements = (policy?.Properties?.PolicyDocument?.Statement ?? []) as Array<{
      Action: string | string[];
      Resource: unknown;
    }>;
    const tables = statements
      .filter((st) => [st.Action].flat().some((a) => a.startsWith("dynamodb:")))
      .map((st) => JSON.stringify(st.Resource));
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.every((r) => r.includes("DataConnections"))).toBe(true);
    const actions = statements
      .flatMap((st) => [st.Action].flat())
      .sort((a, b) => a.localeCompare(b));
    expect(actions).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:Scan",
      "execute-api:ManageConnections",
    ]);
  });
});
