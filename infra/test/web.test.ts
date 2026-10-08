import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  // Skip asset bundling (Lambda esbuild + vite build): only the template is checked here.
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stack = new SlackStack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

describe("web hosting", () => {
  it("serves the SPA from a private bucket through CloudFront over HTTPS", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        PriceClass: "PriceClass_100",
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "redirect-to-https",
          Compress: true,
          ResponseHeadersPolicyId: Match.anyValue(),
        }),
        CustomErrorResponses: [
          {
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: "/index.html",
            ErrorCachingMinTTL: 0,
          },
          {
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: "/index.html",
            ErrorCachingMinTTL: 0,
          },
        ],
      }),
    });
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  });

  it("uploads hashed assets as immutable and entry points as no-cache with invalidation", () => {
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      Exclude: ["index.html", "config.json"],
      SystemMetadata: { "cache-control": "public, max-age=31536000, immutable" },
      Prune: false,
    });
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      Exclude: ["*"],
      Include: ["index.html", "config.json"],
      SystemMetadata: { "cache-control": "no-cache" },
      DistributionPaths: ["/*"],
    });
  });

  it("writes config.json with the live WebSocket URL and Cognito ids at deploy time", () => {
    const [entry] = Object.values(
      template.findResources("Custom::CDKBucketDeployment", {
        Properties: { Include: ["index.html", "config.json"] },
      }),
    );
    const markers = JSON.stringify(entry?.Properties?.SourceMarkers);
    expect(markers).toMatch(/wss:\/\/.*ApiWebSocketApi.*execute-api.*\/prod/); // WebSocket URL
    expect(markers).toMatch(/AuthUserPool[A-Z0-9]+"/); // user pool id
    expect(markers).toContain("AuthUserPoolWebClient"); // app client id
  });

  it("outputs the CloudFront URL", () => {
    template.hasOutput("CloudFrontUrl", {
      Value: { "Fn::Join": ["", ["https://", { "Fn::GetAtt": [Match.anyValue(), "DomainName"] }]] },
    });
  });
});
