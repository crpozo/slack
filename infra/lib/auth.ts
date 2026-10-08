import { Duration } from "aws-cdk-lib";
import { AccountRecovery, UserPool, type UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import { removalPolicyFor, type Stage } from "./stage";

export class Auth extends Construct {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;

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
      removalPolicy: removalPolicyFor(props.stage),
    });

    this.userPoolClient = this.userPool.addClient("WebClient", {
      userPoolClientName: `slack-${props.stage}-web`,
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });
  }
}
