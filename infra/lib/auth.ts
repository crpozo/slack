import { fileURLToPath } from "node:url";
import { Duration } from "aws-cdk-lib";
import { GUEST_GROUP, ADMIN_GROUP, userPoolIdParameterName } from "@mindfultech/shared";
import {
  AccountRecovery,
  CfnUserPoolGroup,
  UserPool,
  UserPoolOperation,
  type UserPoolClient,
} from "aws-cdk-lib/aws-cognito";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { LAMBDA_ARCHITECTURE, LAMBDA_BUNDLING, LAMBDA_MEMORY_MB, LAMBDA_RUNTIME } from "./lambda";
import { removalPolicyFor, type Stage } from "./stage";

const HANDLERS_DIR = fileURLToPath(new URL("../../backend/src/handlers/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export class Auth extends Construct {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;
  /** Phase 68: says in the invitation email which app (this one or Discovery) it's for. */
  readonly customMessageFn: NodejsFunction;
  /** Phase 68: the pool's ID, for Discovery (another repo) to import the pool by. */
  readonly userPoolIdParameter: StringParameter;

  constructor(scope: Construct, id: string, props: { stage: Stage }) {
    super(scope, id);

    this.userPool = new UserPool(this, "UserPool", {
      userPoolName: `slack-${props.stage}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // The email an invite by email sends, to a board or (Phase 55) a private
      // channel (Cognito's built-in sender).
      userInvitation: {
        emailSubject: "You're invited to collaborate with MindfulTech",
        emailBody:
          "Hi! You've been invited to collaborate with MindfulTech on MindfulTech Slack.<br><br>" +
          'Sign in at <a href="https://slack.mindfultech.ec">slack.mindfultech.ec</a> with:<br>' +
          "Email: {username}<br>Temporary password: {####}<br><br>" +
          "You'll choose your own password the first time you sign in. " +
          "The temporary password expires in 7 days.",
        smsMessage:
          "Your MindfulTech Slack username is {username} and temporary password is {####}",
      },
      removalPolicy: removalPolicyFor(props.stage),
    });

    // Roles ride in the id token's `cognito:groups`: guests see only the boards
    // they're invited to; admins may also manage any channel. No group = member.
    new CfnUserPoolGroup(this, "GuestsGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: GUEST_GROUP,
      description: "External guests: only the Task Manager boards they are invited to",
    });
    new CfnUserPoolGroup(this, "AdminsGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: ADMIN_GROUP,
      description: "Team admins: may rename any channel",
    });

    this.userPoolClient = this.userPool.addClient("WebClient", {
      userPoolClientName: `slack-${props.stage}-web`,
      generateSecret: false,
      // USER_PASSWORD_AUTH only in dev, to fetch id tokens from the CLI for wscat tests.
      authFlows: { userSrp: true, userPassword: props.stage === "dev" },
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    // Phase 68: the pool is shared with Discovery (discovery.mindfultech.ec, its
    // own repo, app client and groups). An AdminCreateUser it sends with
    // `ClientMetadata.app = "discovery"` gets Discovery's invitation; every
    // other message keeps `userInvitation` above and Cognito's defaults.
    // The function needs no permissions beyond its logs: it only rewrites the
    // event (no pool ID in its environment either, which would be a cycle).
    const customMessageName = `slack-${props.stage}-cognito-custom-message`;
    this.customMessageFn = new NodejsFunction(this, "CustomMessageFn", {
      functionName: customMessageName,
      entry: `${HANDLERS_DIR}cognito-custom-message.ts`,
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
      // The shared size: a cold start is mostly parsing the bundle, and Cognito
      // waits 5 s at most for the trigger.
      memorySize: LAMBDA_MEMORY_MB,
      timeout: Duration.seconds(5),
      projectRoot: REPO_ROOT,
      depsLockFilePath: `${REPO_ROOT}pnpm-lock.yaml`,
      bundling: LAMBDA_BUNDLING,
      logGroup: new LogGroup(this, "CustomMessageLogs", {
        logGroupName: `/aws/lambda/${customMessageName}`,
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: removalPolicyFor(props.stage),
      }),
    });
    this.userPool.addTrigger(UserPoolOperation.CUSTOM_MESSAGE, this.customMessageFn);

    // Phase 68: Discovery reads this with `StringParameter.valueForStringParameter`
    // and imports the pool (it never creates or changes it).
    this.userPoolIdParameter = new StringParameter(this, "UserPoolIdParameter", {
      parameterName: userPoolIdParameterName(props.stage),
      stringValue: this.userPool.userPoolId,
      description: "Cognito User Pool ID of MindfulTech Slack, shared with Discovery",
    });
  }
}
