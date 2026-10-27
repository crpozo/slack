import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestAttachments", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

const s3ActionsOf = (prefix: string) => {
  const policy = Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
    id.startsWith(prefix),
  )?.[1];
  const statements = (policy?.Properties?.PolicyDocument?.Statement ?? []) as Array<{
    Action: string | string[];
  }>;
  return statements.flatMap((st) => [st.Action].flat()).filter((a) => a.startsWith("s3:"));
};

describe("attachments", () => {
  it("lets history and message sign download URLs (GetObject), and nothing more on S3", () => {
    expect(s3ActionsOf("ApihistoryFnServiceRoleDefaultPolicy")).toEqual(["s3:GetObject"]);
    expect(s3ActionsOf("ApimessageFnServiceRoleDefaultPolicy")).toEqual(["s3:GetObject"]);
    expect(s3ActionsOf("ApipresignFnServiceRoleDefaultPolicy").sort()).toEqual([
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
    ]);
    expect(s3ActionsOf("ApireactFnServiceRoleDefaultPolicy")).toEqual([]);
  });

  it("allows the browser to send the signed Cache-Control header on uploads", () => {
    const [bucket] = Object.values(
      template.findResources("AWS::S3::Bucket", {
        Properties: {
          LifecycleConfiguration: {
            Rules: Match.arrayWith([Match.objectLike({ Status: "Enabled" })]),
          },
        },
      }),
    );
    const rules = bucket?.Properties.CorsConfiguration.CorsRules as Array<{
      AllowedHeaders: string[];
      AllowedMethods: string[];
    }>;
    expect(rules).toHaveLength(1);
    expect(rules[0]?.AllowedMethods).toEqual(["PUT", "GET"]);
    expect(rules[0]?.AllowedHeaders).toEqual(["content-type", "content-length", "cache-control"]);
  });

  it("only moves files above Glacier IR's minimum billable size to cold storage", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: "ColdAfter90Days",
            Status: "Enabled",
            ObjectSizeGreaterThan: 131072,
            Transitions: [{ StorageClass: "GLACIER_IR", TransitionInDays: 90 }],
          }),
          Match.objectLike({
            Id: "AbortStaleMultipartUploads",
            Status: "Enabled",
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          }),
        ]),
      },
    });
  });
});
