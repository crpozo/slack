import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

const CERT = "arn:aws:acm:us-east-1:123456789012:certificate/abc-123";

function synth(stage: "dev" | "prod", context: Record<string, string> = {}): Template {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [], ...context } });
  const stack = new SlackStack(app, `Test${stage}`, {
    env: { account: "123456789012", region: "us-east-1" },
    stage,
  });
  return Template.fromStack(stack);
}

describe("attachments CORS", () => {
  it("only allows the app origins and localhost", () => {
    const template = synth("prod");
    template.hasResourceProperties("AWS::S3::Bucket", {
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
    template.resourceCountIs("AWS::ApiGatewayV2::DomainName", 0);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ Aliases: Match.absent() }),
    });
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
    template.resourceCountIs("AWS::Route53::RecordSet", 2);
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "slack.mindfultech.ec.",
      Type: "A",
      HostedZoneId: "Z123",
    });
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "ws.mindfultech.ec.",
      Type: "A",
    });
  });
});

describe("cost alerts", () => {
  it("monitors anomalies on the project=slack tag and emails daily in prod", () => {
    const template = synth("prod");
    template.hasResourceProperties("AWS::CE::AnomalyMonitor", {
      MonitorType: "CUSTOM",
      MonitorSpecification: Match.serializedJson({
        Tags: { Key: "project", Values: ["slack"], MatchOptions: ["EQUALS"] },
      }),
    });
    template.hasResourceProperties("AWS::CE::AnomalySubscription", {
      Frequency: "DAILY",
      Subscribers: [{ Type: "EMAIL", Address: "carlos@mindfultech.ec" }],
    });
    template.resourceCountIs("AWS::Budgets::Budget", 1);
  });

  it("are not created in dev", () => {
    const template = synth("dev");
    template.resourceCountIs("AWS::CE::AnomalyMonitor", 0);
    template.resourceCountIs("AWS::Budgets::Budget", 0);
  });
});

describe("GitHub deploy role", () => {
  it("trusts only main of crpozo/slack via OIDC and can only assume CDK roles", () => {
    const template = synth("prod");
    template.hasResourceProperties("AWS::IAM::Role", {
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
    template.hasResourceProperties("AWS::IAM::Policy", {
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
    template.hasOutput("GitHubDeployRoleArn", {});
  });

  it("reuses an existing OIDC provider when its ARN is given", () => {
    const template = synth("prod", {
      githubOidcProviderArn:
        "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
    });
    template.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
  });

  it("does not exist in dev", () => {
    synth("dev").resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
  });
});
