import { App, Tags } from "aws-cdk-lib";
import { SlackStack } from "../lib/slack-stack";

const app = new App();
Tags.of(app).add("project", "slack");

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" };

// A stack adds itself to `app` when it's built (Phase 69: named, so it doesn't
// read as an object made and thrown away).
export const devStack = new SlackStack(app, "SlackDev", { env, stage: "dev" });
export const prodStack = new SlackStack(app, "SlackProd", {
  env,
  stage: "prod",
  terminationProtection: true,
});
