import { ArnFormat, Stack } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { vapidParameterName, type Stage } from "./stage";

/**
 * Lets `fn` read (and decrypt) the parameter `name`, and nothing else in
 * Parameter Store. Decryption with the AWS-managed `aws/ssm` key needs no KMS
 * grant: its key policy allows use through SSM to principals of the account.
 */
export function grantReadParameter(fn: IFunction, name: string): void {
  const parameterArn = Stack.of(fn).formatArn({
    service: "ssm",
    resource: "parameter",
    resourceName: name.slice(1),
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
  fn.addToRolePolicy(
    new PolicyStatement({ actions: ["ssm:GetParameter"], resources: [parameterArn] }),
  );
}

/** This stage's VAPID parameter. */
export function grantReadVapid(fn: IFunction, stage: Stage): void {
  grantReadParameter(fn, vapidParameterName(stage));
}
