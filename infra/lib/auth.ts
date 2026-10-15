import { Duration } from "aws-cdk-lib";
import { GUEST_GROUP, ADMIN_GROUP } from "@mindfultech/shared";
import {
  AccountRecovery,
  CfnUserPoolGroup,
  UserPool,
  type UserPoolClient,
} from "aws-cdk-lib/aws-cognito";
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
      // The email a board owner's invite sends (Cognito's built-in sender).
      userInvitation: {
        emailSubject: "You're invited to a MindfulTech board",
        emailBody:
          "Hi! You've been invited to collaborate on a MindfulTech Slack board.<br><br>" +
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
  }
}
