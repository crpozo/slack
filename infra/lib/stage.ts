import { RemovalPolicy } from "aws-cdk-lib";

export type Stage = "dev" | "prod";

/** Dev resources are disposable; prod resources survive a stack deletion. */
export function removalPolicyFor(stage: Stage): RemovalPolicy {
  return stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}
