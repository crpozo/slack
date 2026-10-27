import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { LAMBDA_BUNDLING, LAMBDA_MEMORY_MB } from "../lib/lambda";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestLambda", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

describe("the project's Lambdas", () => {
  it("all run on arm64 Node 22 with the shared memory size", () => {
    const functions = Object.entries(template.findResources("AWS::Lambda::Function")).filter(
      // CDK's own singleton Lambdas (bucket deployment, log retention…) are not ours.
      ([id]) => !id.startsWith("CustomCDK") && !id.startsWith("Custom"),
    );
    expect(functions.length).toBeGreaterThanOrEqual(24);
    for (const [id, fn] of functions) {
      expect(fn.Properties, id).toMatchObject({
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        MemorySize: LAMBDA_MEMORY_MB,
      });
    }
  });

  it("are bundled as ES modules with the SDK inside, minified, without source maps", () => {
    expect(LAMBDA_BUNDLING).toMatchObject({
      format: "esm",
      mainFields: ["module", "main"],
      minify: true,
      sourceMap: false,
      externalModules: [],
    });
    // CommonJS dependencies inside an ESM bundle need a `require` of their own.
    expect(LAMBDA_BUNDLING.banner).toContain("createRequire(import.meta.url)");
  });
});
