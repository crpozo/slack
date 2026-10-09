import type { Node } from "constructs";
import type { Stage } from "./stage";

/**
 * Custom domains for a stage. Everything is optional: without a certificate
 * the stack keeps serving on the CloudFront and execute-api hostnames.
 *
 * Each value comes from CDK context (`-c key=value`) or an environment variable:
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
  const get = (contextKey: string, envKey: string): string | undefined => {
    const value: unknown = node.tryGetContext(contextKey) ?? process.env[envKey];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
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
