import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

// Phase 59: call links. The WebSocket authorizer checks a link's token against
// its call's row, so it may read that table, and nothing more.

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestGuestCalls", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

type Statement = { Action: string | string[]; Resource: unknown };
const statementsOf = (prefix: string) =>
  (Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
    id.startsWith(prefix),
  )?.[1]?.Properties?.PolicyDocument?.Statement ?? []) as Statement[];

describe("call links (Phase 59)", () => {
  it("let the WebSocket authorizer read a call's row, and nothing else", () => {
    const statements = statementsOf("ApiauthorizerFnServiceRoleDefaultPolicy");
    const actions = statements.flatMap((s) => [s.Action].flat());
    expect(actions).toEqual(["dynamodb:GetItem"]);
    expect(JSON.stringify(statements[0]?.Resource)).toMatch(/DataCallRooms/);
  });

  it("let the call handler read the caller's name for their seat", () => {
    const statements = statementsOf("ApicallFnServiceRoleDefaultPolicy");
    const onUsers = statements.filter((s) => JSON.stringify(s.Resource).includes("DataUsers"));
    expect(onUsers.flatMap((s) => [s.Action].flat())).toEqual(["dynamodb:GetItem"]);
  });
});
