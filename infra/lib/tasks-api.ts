import { fileURLToPath } from "node:url";
import { Duration, Stack } from "aws-cdk-lib";
import {
  CfnApi,
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
  type IHttpRouteAuthorizer,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { Api } from "./api";
import type { Auth } from "./auth";
import type { Data } from "./data";
import { removalPolicyFor, vapidParameterName, type Stage } from "./stage";
import { grantReadVapid } from "./vapid";

const HANDLERS_DIR = fileURLToPath(new URL("../../backend/src/handlers/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every route of the Task Manager API, all behind the JWT authorizer. */
export const TASKS_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/boards" },
  { method: HttpMethod.POST, path: "/boards" },
  { method: HttpMethod.PUT, path: "/boards/{id}" },
  { method: HttpMethod.DELETE, path: "/boards/{id}" },
  { method: HttpMethod.POST, path: "/boards/{id}/members" },
  { method: HttpMethod.POST, path: "/boards/{id}/invites" },
  { method: HttpMethod.GET, path: "/boards/{id}/tasks" },
  { method: HttpMethod.POST, path: "/boards/{id}/tasks" },
  // Phase 29: an AI notes card's action items, all at once.
  { method: HttpMethod.POST, path: "/boards/{id}/tasks/from-notes" },
  { method: HttpMethod.PUT, path: "/tasks/{taskId}" },
  { method: HttpMethod.DELETE, path: "/tasks/{taskId}" },
];

/** Company calendar (Phase 19): events, vacation requests and the yearly allowance, its own Lambda. */
export const CALENDAR_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/calendar/events" },
  { method: HttpMethod.POST, path: "/calendar/events" },
  { method: HttpMethod.PUT, path: "/calendar/events/{id}" },
  { method: HttpMethod.DELETE, path: "/calendar/events/{id}" },
  { method: HttpMethod.PUT, path: "/calendar/vacations/{id}/status" },
  { method: HttpMethod.GET, path: "/calendar/balances" },
  { method: HttpMethod.PUT, path: "/calendar/balances/{userId}/{year}" },
];

/**
 * AI call notes (Phase 28): the caller's app submits a call's transcript; a
 * worker summarizes it. The AI Notes hub (Phase 29) lists them.
 */
export const CALL_NOTES_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.POST, path: "/calls/summary" },
  { method: HttpMethod.GET, path: "/notes" },
];

/** The notes model: Claude Haiku 5.5 on Claude in Amazon Bedrock (the Mantle endpoint). */
export const NOTES_MODEL_ID = "anthropic.claude-haiku-5-5";

/**
 * What `bedrock-mantle:CreateInference` is granted on. The model-scoped ARN
 * format for Claude in Amazon Bedrock wasn't verifiable when this was written
 * (the AWS service authorization reference lists it), so the action is
 * granted on all resources: the worker only ever names `NOTES_MODEL_ID`.
 * Narrow this to the Haiku 5.5 model ARN once confirmed.
 */
export const NOTES_MODEL_RESOURCES = ["*"];

/** Deleting messages (Phase 32): by their author or an admin, its own small Lambda. */
export const MESSAGES_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.DELETE, path: "/messages/{channelId}/{sk}" },
];

/** Web Push subscriptions (Phase 8), served by their own small Lambda on the same API. */
export const PUSH_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/push/key" },
  { method: HttpMethod.POST, path: "/push/subscribe" },
  { method: HttpMethod.DELETE, path: "/push/subscribe" },
];

interface TasksApiProps {
  stage: Stage;
  auth: Auth;
  data: Data;
  /** The chat WebSocket API: board changes are pushed to members' connections. */
  wsApi: Api;
  /** Browser origins allowed to call the API (more can be added later with `allowOrigins`). */
  allowOrigins: string[];
  /** Phase 32: deleted messages' and boards' files are removed from it. */
  attachments: IBucket;
}

/**
 * Deleting files from the attachments bucket (Phase 32), only under
 * `attachments/`. `list`: also listing that prefix (a board's files are found
 * by prefix; a message names its own).
 */
function grantDeleteFiles(fn: NodejsFunction, bucket: IBucket, { list = false } = {}): void {
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ["s3:DeleteObject"],
      resources: [bucket.arnForObjects("attachments/*")],
    }),
  );
  if (list) {
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [bucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": ["attachments/*"] } },
      }),
    );
  }
}

/**
 * Task Manager: an HTTP API (API Gateway v2) separate from the WebSocket API.
 * Cognito id tokens are verified by API Gateway's JWT authorizer, so no
 * authorizer Lambda runs; one `tasks` Lambda serves every route.
 */
export class TasksApi extends Construct {
  readonly httpApi: HttpApi;
  readonly handler: NodejsFunction;
  /** `push`: stores browsers' Web Push subscriptions; only touches that table and the VAPID parameter. */
  readonly pushHandler: NodejsFunction;
  /** `archive-tasks`: daily, archives tasks done for over a week (only touches the tasks table). */
  readonly archiveHandler: NodejsFunction;
  /** `calendar`: meetings, vacation requests (with the ledger) and holidays. */
  readonly calendarHandler: NodejsFunction;
  readonly callNotesHandler: NodejsFunction;
  readonly callNotesWorker: NodejsFunction;
  /** `messages`: deleting a message (Phase 32). */
  readonly messagesHandler: NodejsFunction;
  /** Base URL clients call, without a trailing slash. */
  readonly url: string;
  private readonly origins: string[];

  constructor(scope: Construct, id: string, props: TasksApiProps) {
    super(scope, id);
    const { stage, auth, data, wsApi } = props;
    this.origins = [...props.allowOrigins];

    const lambda = (
      id: string,
      name: string,
      environment: Record<string, string>,
      timeout = Duration.seconds(10),
    ) => {
      const functionName = `slack-${stage}-${name}`;
      return new NodejsFunction(this, id, {
        functionName,
        entry: `${HANDLERS_DIR}${name}.ts`,
        handler: "handler",
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 256,
        timeout,
        environment: { STAGE: stage, LOG_LEVEL: "info", ...environment },
        projectRoot: REPO_ROOT,
        depsLockFilePath: `${REPO_ROOT}pnpm-lock.yaml`,
        bundling: { minify: true, sourceMap: false, target: "node22", externalModules: [] },
        logGroup: new LogGroup(this, `${id === "Fn" ? "" : id}Logs`, {
          logGroupName: `/aws/lambda/${functionName}`,
          retention: RetentionDays.ONE_WEEK,
          removalPolicy: removalPolicyFor(stage),
        }),
      });
    };

    this.handler = lambda("Fn", "tasks", {
      BOARDS_TABLE: data.boards.tableName,
      TASKS_TABLE: data.tasks.tableName,
      USERS_TABLE: data.users.tableName,
      CONNECTIONS_TABLE: data.connections.tableName,
      WS_ENDPOINT: wsApi.webSocketStage.callbackUrl,
      // Board invites create guest accounts in the pool.
      USER_POOL_ID: auth.userPool.userPoolId,
      // Web Push to members away from the app (new tasks, column moves).
      PUSH_SUBSCRIPTIONS_TABLE: data.pushSubscriptions.tableName,
      VAPID_PARAMETER: vapidParameterName(stage),
      // Action items from AI notes (Phase 29): the notes card and its conversation.
      MESSAGES_TABLE: data.messages.tableName,
      CHANNELS_TABLE: data.channels.tableName,
      // A deleted board's files (Phase 32).
      ATTACHMENTS_BUCKET: props.attachments.bucketName,
    });
    this.pushHandler = lambda("PushFn", "push", {
      PUSH_SUBSCRIPTIONS_TABLE: data.pushSubscriptions.tableName,
      VAPID_PARAMETER: vapidParameterName(stage),
    });

    this.calendarHandler = lambda("CalendarFn", "calendar", {
      EVENTS_TABLE: data.events.tableName,
      VACATION_BALANCES_TABLE: data.vacationBalances.tableName,
      // Meetings scheduled from a DM post a card in it (same transaction as the event).
      MESSAGES_TABLE: data.messages.tableName,
      CHANNELS_TABLE: data.channels.tableName,
      USERS_TABLE: data.users.tableName,
      CONNECTIONS_TABLE: data.connections.tableName,
      WS_ENDPOINT: wsApi.webSocketStage.callbackUrl,
      // Who the admins are (vacation requests are pushed to them).
      USER_POOL_ID: auth.userPool.userPoolId,
      PUSH_SUBSCRIPTIONS_TABLE: data.pushSubscriptions.tableName,
      VAPID_PARAMETER: vapidParameterName(stage),
    });

    // AI call notes: the endpoint answers at once (202) and hands the
    // transcript to the worker, which may take longer than API Gateway's 30 s.
    this.callNotesWorker = lambda(
      "CallNotesWorkerFn",
      "call-notes-worker",
      {
        MESSAGES_TABLE: data.messages.tableName,
        USERS_TABLE: data.users.tableName,
        CONNECTIONS_TABLE: data.connections.tableName,
        WS_ENDPOINT: wsApi.webSocketStage.callbackUrl,
      },
      Duration.minutes(2),
    );
    // Errors become a failed card inside the worker; an async retry would only repeat them.
    this.callNotesWorker.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.hours(1) });
    this.callNotesHandler = lambda("CallNotesFn", "call-notes", {
      MESSAGES_TABLE: data.messages.tableName,
      CHANNELS_TABLE: data.channels.tableName,
      CONNECTIONS_TABLE: data.connections.tableName,
      WS_ENDPOINT: wsApi.webSocketStage.callbackUrl,
      NOTES_WORKER_FUNCTION: this.callNotesWorker.functionName,
      MEETING_NOTES_TABLE: data.meetingNotes.tableName,
    });

    this.archiveHandler = lambda(
      "ArchiveFn",
      "archive-tasks",
      {
        TASKS_TABLE: data.tasks.tableName,
        // Phase 32: finishing interrupted board deletions.
        BOARDS_TABLE: data.boards.tableName,
        CHANNELS_TABLE: data.channels.tableName,
        ATTACHMENTS_BUCKET: props.attachments.bucketName,
      },
      Duration.minutes(5), // scans the whole tasks table
    );
    this.messagesHandler = lambda("MessagesFn", "messages", {
      MESSAGES_TABLE: data.messages.tableName,
      CHANNELS_TABLE: data.channels.tableName,
      CONNECTIONS_TABLE: data.connections.tableName,
      MEETING_NOTES_TABLE: data.meetingNotes.tableName,
      ATTACHMENTS_BUCKET: props.attachments.bucketName,
      WS_ENDPOINT: wsApi.webSocketStage.callbackUrl,
    });
    new Rule(this, "ArchiveSchedule", {
      ruleName: `slack-${stage}-archive-done-tasks`,
      description: "Archives Kanban tasks that have been Done for over a week",
      schedule: Schedule.cron({ hour: "6", minute: "17" }), // daily, 01:17 in Ecuador
      targets: [new LambdaFunction(this.archiveHandler, { retryAttempts: 2 })],
    });

    const region = Stack.of(this).region;
    const authorizer: IHttpRouteAuthorizer = new HttpJwtAuthorizer(
      "Jwt",
      `https://cognito-idp.${region}.amazonaws.com/${auth.userPool.userPoolId}`,
      { jwtAudience: [auth.userPoolClient.userPoolClientId], authorizerName: `slack-${stage}-jwt` },
    );

    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: `slack-${stage}-tasks`,
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: this.origins,
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });
    const integration = new HttpLambdaIntegration("TasksIntegration", this.handler);
    for (const { method, path } of TASKS_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration });
    }
    const messagesIntegration = new HttpLambdaIntegration(
      "MessagesIntegration",
      this.messagesHandler,
    );
    for (const { method, path } of MESSAGES_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: messagesIntegration });
    }
    const pushIntegration = new HttpLambdaIntegration("PushIntegration", this.pushHandler);
    for (const { method, path } of PUSH_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: pushIntegration });
    }
    const callNotesIntegration = new HttpLambdaIntegration(
      "CallNotesIntegration",
      this.callNotesHandler,
    );
    for (const { method, path } of CALL_NOTES_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: callNotesIntegration });
    }
    const calendarIntegration = new HttpLambdaIntegration(
      "CalendarIntegration",
      this.calendarHandler,
    );
    for (const { method, path } of CALENDAR_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: calendarIntegration });
    }
    this.url = this.httpApi.apiEndpoint;

    // --- Permissions: only what the handler calls ---
    data.boards.grant(
      this.handler,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:BatchGetItem",
      "dynamodb:DeleteItem", // board row (owner only)
      "dynamodb:BatchWriteItem", // membership rows of a deleted board
    );
    data.boards.grant(this.handler, "dynamodb:Query"); // table + byUser index
    data.tasks.grant(
      this.handler,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:BatchWriteItem", // a deleted board's tasks
    );
    // Invitees must exist (BatchGetItem); the actor's display name for pushes (GetItem);
    // an invited person's directory row (UpdateItem).
    data.users.grant(
      this.handler,
      "dynamodb:BatchGetItem",
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    );
    // Invites by email: look the address up, create a guest account (Cognito emails
    // the temporary password) and put it in `guests` — deleting it if that fails.
    this.handler.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminDeleteUser",
        ],
        resources: [auth.userPool.userPoolArn],
      }),
    );
    // Push: each member's devices (Query), dropping expired ones (DeleteItem).
    data.pushSubscriptions.grant(this.handler, "dynamodb:Query", "dynamodb:DeleteItem");
    grantReadVapid(this.handler, stage);
    // Real-time pushes: list live connections, post to members', drop stale ones (410).
    data.connections.grant(this.handler, "dynamodb:Scan", "dynamodb:DeleteItem");
    wsApi.webSocketApi.grantManageConnections(this.handler);
    // Tasks from AI notes: the conversation (GetItem), the notes card (GetItem) and
    // claiming it as sent (UpdateItem, in the same transaction as the tasks' PutItem).
    // Deleting a board (Phase 32): unlinking project channels (Scan, UpdateItem) and
    // removing its files.
    data.channels.grant(this.handler, "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:UpdateItem");
    grantDeleteFiles(this.handler, props.attachments, { list: true });
    data.messages.grant(this.handler, "dynamodb:GetItem", "dynamodb:UpdateItem");

    // calendar: events by id and by year; the ledger by person/year and by year (admins).
    data.events.grant(
      this.calendarHandler,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    );
    data.vacationBalances.grant(
      this.calendarHandler,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    );
    // Invitees must exist and not be guests (BatchGetItem); the actor's name for pushes (GetItem).
    data.users.grant(this.calendarHandler, "dynamodb:BatchGetItem", "dynamodb:GetItem");
    // DM meetings: the conversation must be the caller's (GetItem); the card is
    // written with the event (PutItem), rewritten when the meeting is edited
    // (UpdateItem) and a retried request finds it (Query). Phase 34: every
    // invitee's card goes in their DM with the organizer, opened if they never
    // talked (channels PutItem), and bumps that DM in the sidebar (UpdateItem).
    data.channels.grant(
      this.calendarHandler,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    );
    data.messages.grant(
      this.calendarHandler,
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    );
    this.calendarHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["cognito-idp:ListUsersInGroup"],
        resources: [auth.userPool.userPoolArn],
      }),
    );
    data.pushSubscriptions.grant(this.calendarHandler, "dynamodb:Query", "dynamodb:DeleteItem");
    grantReadVapid(this.calendarHandler, stage);
    data.connections.grant(this.calendarHandler, "dynamodb:Scan", "dynamodb:DeleteItem");
    wsApi.webSocketApi.grantManageConnections(this.calendarHandler);

    // call-notes: the DM (GetItem), a retried request's card (Query), the pending
    // card (PutItem) and marking it failed (UpdateItem); its push; starting the worker.
    // The hub: each person's pointer (PutItem, with the card), listing them (Query)
    // and loading the cards they point to (BatchGetItem).
    data.channels.grant(this.callNotesHandler, "dynamodb:GetItem");
    data.messages.grant(
      this.callNotesHandler,
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
      "dynamodb:BatchGetItem",
    );
    data.meetingNotes.grant(this.callNotesHandler, "dynamodb:PutItem", "dynamodb:Query");
    data.connections.grant(this.callNotesHandler, "dynamodb:Scan", "dynamodb:DeleteItem");
    wsApi.webSocketApi.grantManageConnections(this.callNotesHandler);
    this.callNotesWorker.grantInvoke(this.callNotesHandler);
    // call-notes-worker: speakers' names (GetItem), settling the card (UpdateItem),
    // its push, and the model on Claude in Amazon Bedrock. No model is provisioned here.
    data.users.grant(this.callNotesWorker, "dynamodb:GetItem");
    data.messages.grant(this.callNotesWorker, "dynamodb:UpdateItem");
    data.connections.grant(this.callNotesWorker, "dynamodb:Scan", "dynamodb:DeleteItem");
    wsApi.webSocketApi.grantManageConnections(this.callNotesWorker);
    this.callNotesWorker.addToRolePolicy(
      new PolicyStatement({
        actions: ["bedrock-mantle:CreateInference"],
        resources: NOTES_MODEL_RESOURCES,
      }),
    );

    // archive-tasks: find done tasks (Scan) and flag them (UpdateItem). Nothing else.
    data.tasks.grant(this.archiveHandler, "dynamodb:Scan", "dynamodb:UpdateItem");
    // ...and the sweep after board deletions (Phase 32): stamped boards (Scan), their
    // tasks (Query byBoard, BatchWriteItem), whether a task's board exists (BatchGetItem),
    // membership rows and the board row, unlinking project channels, the board's files.
    data.boards.grant(
      this.archiveHandler,
      "dynamodb:Scan",
      "dynamodb:Query",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:DeleteItem",
    );
    data.tasks.grant(this.archiveHandler, "dynamodb:Query", "dynamodb:BatchWriteItem");
    data.channels.grant(this.archiveHandler, "dynamodb:Scan", "dynamodb:UpdateItem");
    grantDeleteFiles(this.archiveHandler, props.attachments, { list: true });

    // messages (Phase 32): the conversation (GetItem), the message (GetItem), deleting it
    // or making it a tombstone and recounting its thread (DeleteItem, UpdateItem in one
    // transaction), its thread's replies and the quotes of it (Query), clearing those
    // quotes (UpdateItem); a notes card's hub entries; its files; the push.
    data.channels.grant(this.messagesHandler, "dynamodb:GetItem");
    data.messages.grant(
      this.messagesHandler,
      "dynamodb:GetItem",
      "dynamodb:DeleteItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    );
    data.meetingNotes.grant(this.messagesHandler, "dynamodb:DeleteItem");
    data.connections.grant(this.messagesHandler, "dynamodb:Scan", "dynamodb:DeleteItem");
    wsApi.webSocketApi.grantManageConnections(this.messagesHandler);
    grantDeleteFiles(this.messagesHandler, props.attachments);

    // push: the caller's own subscription rows, and the public half of the VAPID keys.
    data.pushSubscriptions.grant(this.pushHandler, "dynamodb:PutItem", "dynamodb:DeleteItem");
    grantReadVapid(this.pushHandler, stage);
  }

  /**
   * Adds browser origins after construction (the CloudFront domain only exists
   * once the Web construct does, which itself needs this API's URL).
   */
  allowOrigins(origins: string[]): void {
    this.origins.push(...origins.filter((o) => !this.origins.includes(o)));
    const cfn = this.httpApi.node.defaultChild as CfnApi;
    cfn.addPropertyOverride("CorsConfiguration.AllowOrigins", this.origins);
  }
}
