import { App } from "aws-cdk-lib";
import { VAULT_METADATA_ATTRIBUTES, VAULT_PIN_ATTRIBUTES } from "@mindfultech/shared";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SlackStack } from "../lib/slack-stack";

let template: Template;

beforeAll(() => {
  const app = new App({
    context: { "aws:cdk:bundling-stacks": [], budgetEmail: "alerts@example.com" },
  });
  const stack = new SlackStack(app, "TestVault", {
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
const actionsOf = (statements: Statement[]) =>
  statements.flatMap((st) => [st.Action].flat()).sort((a, b) => a.localeCompare(b));
const on = (statements: Statement[], resource: string) =>
  statements.filter((st) => JSON.stringify(st.Resource).includes(resource));

describe("Vault (Phase 45)", () => {
  it("has its own rotating, customer-managed KMS key", () => {
    template.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
      PendingWindowInDays: 30,
      Description: "MindfulTech Slack Vault: encrypts the team's stored passwords",
    });
    template.hasResourceProperties("AWS::KMS::Alias", { AliasName: "alias/slack-dev-vault" });
  });

  it("keeps secrets by secretId, encrypted at rest, with no index (Phase 46)", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "slack-dev-vault",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "secretId", KeyType: "HASH" }],
      SSESpecification: { SSEEnabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    const vault = Object.values(
      template.findResources("AWS::DynamoDB::Table", {
        Properties: { TableName: "slack-dev-vault" },
      }),
    )[0]?.Properties as { GlobalSecondaryIndexes?: unknown };
    expect(vault.GlobalSecondaryIndexes).toBeUndefined();
  });

  it("serves every route behind the JWT authorizer from the vault Lambda", () => {
    for (const key of [
      "GET /vault",
      "POST /vault",
      "GET /vault/channels/{channelId}",
      "POST /vault/reveal/{secretId}",
      "PUT /vault/secrets/{secretId}",
      "DELETE /vault/secrets/{secretId}",
      "GET /vault/pin",
      "POST /vault/pin",
      "POST /vault/pin/verify",
      "DELETE /vault/pin/{userId}",
    ]) {
      const route = Object.values(
        template.findResources("AWS::ApiGatewayV2::Route", { Properties: { RouteKey: key } }),
      )[0]?.Properties as { AuthorizationType: string; Target: unknown };
      expect([key, route.AuthorizationType]).toEqual([key, "JWT"]);
      expect(JSON.stringify(route.Target)).toMatch(/VaultIntegration/);
    }
    const fn = Object.values(
      template.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "slack-dev-vault" },
      }),
    )[0]?.Properties as { Environment: { Variables: Record<string, unknown> } };
    expect(Object.keys(fn.Environment.Variables).sort()).toEqual([
      "CHANNELS_TABLE",
      "CONNECTIONS_TABLE",
      "LOG_LEVEL",
      "MESSAGES_TABLE",
      "STAGE",
      "USERS_TABLE",
      "VAULT_KEY_ID",
      "VAULT_TABLE",
      "WS_ENDPOINT",
    ]);
    expect(JSON.stringify(fn.Environment.Variables.VAULT_KEY_ID)).toMatch(/DataVaultKey/);
  });

  it("lets only the vault Lambda use the key: Encrypt and Decrypt, with the Vault's contexts", () => {
    const st = statementsOf("TasksApiVaultFnServiceRoleDefaultPolicy");
    const kms = st.filter((s) => JSON.stringify(s.Action).includes("kms:"));
    expect(kms).toHaveLength(1);
    expect(actionsOf(kms)).toEqual(["kms:Decrypt", "kms:Encrypt"]);
    expect(JSON.stringify(kms[0]?.Resource)).toMatch(/DataVaultKey/);
    expect(kms[0]?.Condition).toEqual({
      StringEquals: { "kms:EncryptionContext:purpose": ["vault", "vault-pin"] },
    });
    // No other function's policy mentions the key.
    const others = Object.entries(template.findResources("AWS::IAM::Policy")).filter(
      ([id, p]) => !id.startsWith("TasksApiVaultFn") && JSON.stringify(p).includes("DataVaultKey"),
    );
    expect(others.map(([id]) => id)).toEqual([]);
  });

  it("reads rows one at a time; its Scans can only ask for the metadata, never the ciphertext", () => {
    const st = statementsOf("TasksApiVaultFnServiceRoleDefaultPolicy");
    const vault = on(st, "DataVault").filter((s) => !JSON.stringify(s.Action).includes("kms:"));
    const scans = vault.filter((s) => [s.Action].flat().includes("dynamodb:Scan"));
    expect(scans).toHaveLength(1);
    expect(actionsOf(scans)).toEqual(["dynamodb:Scan"]);
    expect(scans[0]?.Condition).toEqual({
      StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": [...VAULT_METADATA_ATTRIBUTES] },
    });
    expect(VAULT_METADATA_ATTRIBUTES).not.toContain("encryptedPassword");
    expect(JSON.stringify(st)).not.toMatch(/index\/byChannel|dynamodb:Query/);
    const rows = vault.filter((s) => s !== scans[0]);
    expect(actionsOf(rows)).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]);
    expect(actionsOf(on(st, "DataMessages"))).toEqual(["dynamodb:PutItem"]);
    expect(actionsOf(on(st, "DataChannels"))).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
    expect(JSON.stringify(st)).not.toMatch(/s3:|bedrock|ssm:/);
  });

  it("touches only the PIN's attributes on users rows, and reads only ids and roles in bulk", () => {
    const st = on(statementsOf("TasksApiVaultFnServiceRoleDefaultPolicy"), "DataUsers");
    const byAction = (action: string) => st.filter((s) => [s.Action].flat().includes(action));
    expect(byAction("dynamodb:GetItem")).toHaveLength(1);
    expect(byAction("dynamodb:UpdateItem")[0]?.Condition).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:Attributes": [...VAULT_PIN_ATTRIBUTES] },
    });
    expect(byAction("dynamodb:Scan")[0]?.Condition).toEqual({
      StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": ["userId", "role"] },
    });
    expect(actionsOf(st)).toEqual(["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:UpdateItem"]);
  });

  it("lets browsers send the Vault's session header", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      Name: "slack-dev-tasks",
      CorsConfiguration: Match.objectLike({
        AllowHeaders: ["authorization", "content-type", "x-vault-session"],
      }),
    });
  });
});
