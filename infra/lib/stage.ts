import { RemovalPolicy } from "aws-cdk-lib";

export type Stage = "dev" | "prod";

/** Dev resources are disposable; prod resources survive a stack deletion. */
export function removalPolicyFor(stage: Stage): RemovalPolicy {
  return stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}

/**
 * SecureString with this stage's Web Push VAPID keys, created by
 * `pnpm --filter infra vapid <stage>` (CloudFormation can't create SecureStrings,
 * and keeping it out of the stack keeps the keys out of every template).
 */
export const vapidParameterName = (stage: Stage) => `/slack/${stage}/vapid`;
