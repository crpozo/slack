import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { ReadWriteType, Trail } from "aws-cdk-lib/aws-cloudtrail";
import { Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { Auth } from "./auth";
import type { Data } from "./data";
import { LAMBDA_ARCHITECTURE, LAMBDA_BUNDLING, LAMBDA_MEMORY_MB, LAMBDA_RUNTIME } from "./lambda";
import { removalPolicyFor, type Stage } from "./stage";

const HANDLERS_DIR = fileURLToPath(new URL("../../backend/src/handlers/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface UserSyncProps {
  stage: Stage;
  auth: Auth;
  data: Data;
  /**
   * Create a CloudTrail trail for management events. EventBridge only gets
   * "AWS API Call via CloudTrail" events while some trail in the account is
   * logging: leave this off if the account already has one (the first copy
   * of management events is free; a second is billed).
   */
  createTrail?: boolean;
}

/**
 * Keeps `users` in step with Cognito: when an admin deletes an account
 * (AdminDeleteUser, seen through CloudTrail), `user-cleanup` deletes its
 * profile row, so a deleted person stops showing in DM lists.
 */
export class UserSync extends Construct {
  readonly handler: NodejsFunction;
  readonly rule: Rule;

  constructor(scope: Construct, id: string, props: UserSyncProps) {
    super(scope, id);
    const { stage, auth, data } = props;
    const functionName = `slack-${stage}-user-cleanup`;

    this.handler = new NodejsFunction(this, "UserCleanupFn", {
      functionName,
      entry: `${HANDLERS_DIR}user-cleanup.ts`,
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
      memorySize: LAMBDA_MEMORY_MB,
      // The fallback reconcile scans `users` and lists the pool: still seconds.
      timeout: Duration.seconds(60),
      environment: {
        STAGE: stage,
        LOG_LEVEL: "info",
        USERS_TABLE: data.users.tableName,
        USER_POOL_ID: auth.userPool.userPoolId,
      },
      projectRoot: REPO_ROOT,
      depsLockFilePath: `${REPO_ROOT}pnpm-lock.yaml`,
      bundling: LAMBDA_BUNDLING,
      logGroup: new LogGroup(this, "UserCleanupLogs", {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: removalPolicyFor(stage),
      }),
    });
    // Delete one row by key; Scan (keys only) for the fallback reconcile.
    data.users.grant(this.handler, "dynamodb:DeleteItem", "dynamodb:Scan");
    // Confirm the account is gone (ListUsers by sub), or list the pool to reconcile.
    this.handler.addToRolePolicy(
      new PolicyStatement({
        actions: ["cognito-idp:ListUsers"],
        resources: [auth.userPool.userPoolArn],
      }),
    );

    this.rule = new Rule(this, "AdminDeleteUserRule", {
      ruleName: `slack-${stage}-cognito-admin-delete-user`,
      description: "Cognito AdminDeleteUser (via CloudTrail): delete the profile from users",
      eventPattern: {
        source: ["aws.cognito-idp"],
        detailType: ["AWS API Call via CloudTrail"],
        detail: {
          eventSource: ["cognito-idp.amazonaws.com"],
          eventName: ["AdminDeleteUser"],
          // Only this stage's pool, and only calls that succeeded.
          requestParameters: { userPoolId: [auth.userPool.userPoolId] },
          errorCode: [{ exists: false }],
        },
      },
      targets: [
        new LambdaFunction(this.handler, {
          retryAttempts: 4,
          maxEventAge: Duration.hours(2),
        }),
      ],
    });

    if (props.createTrail) {
      const logs = new Bucket(this, "TrailLogs", {
        encryption: BucketEncryption.S3_MANAGED,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        // Versioned so a log can't be silently overwritten or deleted; old
        // versions go after a week, current logs after 90 days.
        versioned: true,
        lifecycleRules: [
          { expiration: Duration.days(90), noncurrentVersionExpiration: Duration.days(7) },
        ],
        removalPolicy: stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        autoDeleteObjects: stage !== "prod",
      });
      new Trail(this, "ManagementTrail", {
        trailName: `slack-${stage}-management-events`,
        bucket: logs,
        isMultiRegionTrail: false,
        includeGlobalServiceEvents: false,
        // Only write events: AdminDeleteUser is one; reads would just add volume.
        managementEvents: ReadWriteType.WRITE_ONLY,
      });
    }
  }
}
