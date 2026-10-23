import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestDeletion", {
    env: { account: "123456789012", region: "us-east-1" },
    stage: "dev",
  });
  template = Template.fromStack(stack);
}, 60_000);

type Statement = { Action: string | string[]; Resource: unknown; Condition?: unknown };
const statementsOf = (prefix: string) =>
  (Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
    id.startsWith(prefix),
  )?.[1]?.Properties?.PolicyDocument?.Statement ?? []) as Statement[];
const actionsOn = (statements: Statement[], table: string) =>
  statements
    .filter((st) => JSON.stringify(st.Resource).includes(`"${table}`))
    .flatMap((st) => [st.Action].flat())
    .sort((a, b) => a.localeCompare(b));
const s3Statements = (statements: Statement[]) =>
  statements.filter((st) => [st.Action].flat().some((a) => a.startsWith("s3:")));

describe("deleting messages and boards (Phase 32)", () => {
  it("serves DELETE /messages/{channelId}/{sk} behind the JWT authorizer from its own Lambda", () => {
    const route = Object.values(
      template.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: "DELETE /messages/{channelId}/{sk}" },
      }),
    )[0]?.Properties as { AuthorizationType: string; Target: unknown };
    expect(route.AuthorizationType).toBe("JWT");
    expect(JSON.stringify(route.Target)).toMatch(/MessagesIntegration/);
  });

  it("grants the messages Lambda only what deleting a message needs", () => {
    const st = statementsOf("TasksApiMessagesFnServiceRoleDefaultPolicy");
    expect(actionsOn(st, "DataMessages")).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(actionsOn(st, "DataChannels")).toEqual(["dynamodb:GetItem"]);
    expect(actionsOn(st, "DataMeetingNotes")).toEqual(["dynamodb:DeleteItem"]);
    expect(actionsOn(st, "DataBoards")).toEqual([]);
    // Files: delete only, under attachments/ only, no listing.
    const s3 = s3Statements(st);
    expect(s3.flatMap((s) => [s.Action].flat())).toEqual(["s3:DeleteObject"]);
    expect(JSON.stringify(s3[0]?.Resource)).toContain("/attachments/*");
  });

  it("lets the tasks and archive Lambdas delete a board's files by prefix, nothing beyond attachments/", () => {
    for (const prefix of [
      "TasksApiFnServiceRoleDefaultPolicy",
      "TasksApiArchiveFnServiceRoleDefaultPolicy",
    ]) {
      const s3 = s3Statements(statementsOf(prefix));
      expect(s3.flatMap((s) => [s.Action].flat()).sort()).toEqual([
        "s3:DeleteObject",
        "s3:ListBucket",
      ]);
      const list = s3.find((s) => [s.Action].flat().includes("s3:ListBucket"));
      expect(list?.Condition).toEqual({ StringLike: { "s3:prefix": ["attachments/*"] } });
      const del = s3.find((s) => [s.Action].flat().includes("s3:DeleteObject"));
      expect(JSON.stringify(del?.Resource)).toContain("/attachments/*");
    }
  });
});
