import { ArnFormat, Stack } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { vapidParameterName, type Stage } from "./stage";

/**
 * Lets `fn` read (and decrypt) this stage's VAPID parameter, and nothing else
 * in Parameter Store. Decryption with the AWS-managed `aws/ssm` key needs no
 * KMS grant: its key policy allows use through SSM to principals of the account.
 */
export function grantReadVapid(fn: IFunction, stage: Stage): void {
  const parameterArn = Stack.of(fn).formatArn({
    service: "ssm",
    resource: "parameter",
    resourceName: vapidParameterName(stage).slice(1),
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
  fn.addToRolePolicy(
    new PolicyStatement({ actions: ["ssm:GetParameter"], resources: [parameterArn] }),
  );
}
