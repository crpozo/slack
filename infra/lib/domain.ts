import type { Node } from "constructs";
import type { Stage } from "./stage";

/**
 * Custom domains for a stage. Everything is optional: without a certificate
 * the stack keeps serving on the CloudFront and execute-api hostnames.
 *
 * Each value is looked up, first match wins, in:
 *   1. CDK context `-c key=value`;
 *   2. the environment variable;
 *   3. the stage's block in `infra/cdk.json` (`"prod": { "certificateArn": "…" }`) —
 *      committed, so a deploy from any laptop or from CI gets the same domains;
 *   4. the default.
 *
 * | context          | env                | default (prod)          |
 * | ---------------- | ------------------ | ----------------------- |
 * | `appDomain`      | `SLACK_APP_DOMAIN` | `slack.mindfultech.ec`  |
 * | `wsDomain`       | `SLACK_WS_DOMAIN`  | `ws.mindfultech.ec`     |
 * | `certificateArn` | `CERT_ARN`         | —                       |
 * | `hostedZoneId`   | `HOSTED_ZONE_ID`   | —                       |
 * | `hostedZoneName` | `HOSTED_ZONE_NAME` | parent of `appDomain`   |
 */
export interface DomainConfig {
  appDomain?: string;
  wsDomain?: string;
  /** ACM certificate in us-east-1 covering both domains (required by CloudFront). */
  certificateArn?: string;
  /** Route 53 zone to create alias records in; without it, DNS is managed by hand. */
  hostedZoneId?: string;
  hostedZoneName?: string;
}

const PROD_DEFAULTS = { appDomain: "slack.mindfultech.ec", wsDomain: "ws.mindfultech.ec" };

export function resolveDomainConfig(node: Node, stage: Stage): DomainConfig {
  const stageBlock: unknown = node.tryGetContext(stage);
  const fromStageBlock = (key: string): unknown =>
    stageBlock && typeof stageBlock === "object"
      ? (stageBlock as Record<string, unknown>)[key]
      : undefined;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const get = (contextKey: string, envKey: string): string | undefined =>
    text(node.tryGetContext(contextKey)) ??
    text(process.env[envKey]) ??
    text(fromStageBlock(contextKey));
  const defaults: Partial<typeof PROD_DEFAULTS> = stage === "prod" ? PROD_DEFAULTS : {};
  const appDomain = get("appDomain", "SLACK_APP_DOMAIN") ?? defaults.appDomain;
  return {
    appDomain,
    wsDomain: get("wsDomain", "SLACK_WS_DOMAIN") ?? defaults.wsDomain,
    certificateArn: get("certificateArn", "CERT_ARN"),
    hostedZoneId: get("hostedZoneId", "HOSTED_ZONE_ID"),
    hostedZoneName:
      get("hostedZoneName", "HOSTED_ZONE_NAME") ?? appDomain?.split(".").slice(1).join("."),
  };
}

/** Custom domains are wired only when both names and the certificate are known. */
export function customDomainsEnabled(config: DomainConfig): config is DomainConfig & {
  appDomain: string;
  wsDomain: string;
  certificateArn: string;
} {
  return Boolean(config.appDomain && config.wsDomain && config.certificateArn);
}

/** Browser origins allowed to PUT/GET attachments with presigned URLs. */
export const LOCAL_DEV_ORIGINS = ["http://localhost:5173", "http://localhost:4173"];
