import { App, Tags } from "aws-cdk-lib";
import { SlackStack } from "../lib/slack-stack";

const app = new App();
Tags.of(app).add("project", "slack");

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" };

new SlackStack(app, "SlackDev", { env, stage: "dev" });
new SlackStack(app, "SlackProd", { env, stage: "prod", terminationProtection: true });
