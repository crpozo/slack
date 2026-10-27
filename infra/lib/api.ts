import { fileURLToPath } from "node:url";
import { CLIENT_ACTIONS } from "@mindfultech/shared";
import { Duration } from "aws-cdk-lib";
import { ApiMapping, DomainName, WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { Auth } from "./auth";
import type { Data } from "./data";
import { LAMBDA_ARCHITECTURE, LAMBDA_BUNDLING, LAMBDA_MEMORY_MB, LAMBDA_RUNTIME } from "./lambda";
import { removalPolicyFor, vapidParameterName, type Stage } from "./stage";
import { grantReadVapid } from "./vapid";

const HANDLERS_DIR = fileURLToPath(new URL("../../backend/src/handlers/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type Handler =
  "authorizer" | "connect" | "disconnect" | "default" | (typeof CLIENT_ACTIONS)[number];

interface ApiProps {
  stage: Stage;
  auth: Auth;
  data: Data;
  attachments: Bucket;
  /** e.g. `ws.mindfultech.ec`, mapped to the stage at the root path. */
  customDomain?: { domainName: string; certificate: ICertificate };
}

export class Api extends Construct {
  readonly webSocketApi: WebSocketApi;
  readonly webSocketStage: WebSocketStage;
  /** Public `wss://` URL clients use: the custom domain when configured. */
  readonly url: string;
  readonly domainName?: DomainName;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { stage, data } = props;

    this.webSocketApi = new WebSocketApi(this, "WebSocketApi", {
      apiName: `slack-${stage}-ws`,
      routeSelectionExpression: "$request.body.action",
    });
    this.webSocketStage = new WebSocketStage(this, "Stage", {
      webSocketApi: this.webSocketApi,
      stageName: "prod",
      autoDeploy: true,
    });

    if (props.customDomain) {
      this.domainName = new DomainName(this, "CustomDomain", props.customDomain);
      new ApiMapping(this, "CustomDomainMapping", {
        api: this.webSocketApi,
        domainName: this.domainName,
        stage: this.webSocketStage,
      });
      this.url = `wss://${props.customDomain.domainName}`;
    } else {
      this.url = this.webSocketStage.url;
    }

    const environment = {
      STAGE: stage,
      LOG_LEVEL: "info",
      MESSAGES_TABLE: data.messages.tableName,
      CONNECTIONS_TABLE: data.connections.tableName,
      CHANNELS_TABLE: data.channels.tableName,
      USERS_TABLE: data.users.tableName,
      BOARDS_TABLE: data.boards.tableName,
      CALL_ROOMS_TABLE: data.callRooms.tableName,
      CHANNEL_MEDIA_TABLE: data.channelMedia.tableName,
      ATTACHMENTS_BUCKET: props.attachments.bucketName,
      WS_ENDPOINT: this.webSocketStage.callbackUrl,
    };

    const fn = (name: Handler, extraEnv: Record<string, string> = {}) => {
      const functionName = `slack-${stage}-${name}`;
      return new NodejsFunction(this, `${name}Fn`, {
        functionName,
        entry: `${HANDLERS_DIR}${name}.ts`,
        handler: "handler",
        runtime: LAMBDA_RUNTIME,
        architecture: LAMBDA_ARCHITECTURE,
        memorySize: LAMBDA_MEMORY_MB,
        timeout: Duration.seconds(10),
        environment: { ...environment, ...extraEnv },
        projectRoot: REPO_ROOT,
        depsLockFilePath: `${REPO_ROOT}pnpm-lock.yaml`,
        bundling: LAMBDA_BUNDLING,
        // Explicit log group (instead of the deprecated `logRetention`) so it is
        // removed together with the stack in dev.
        logGroup: new LogGroup(this, `${name}Logs`, {
          logGroupName: `/aws/lambda/${functionName}`,
          retention: RetentionDays.ONE_WEEK,
          removalPolicy: removalPolicyFor(stage),
        }),
      });
    };

    const authorizerFn = fn("authorizer", {
      USER_POOL_ID: props.auth.userPool.userPoolId,
      USER_POOL_CLIENT_ID: props.auth.userPoolClient.userPoolClientId,
    });
    const authorizer = new WebSocketLambdaAuthorizer("Authorizer", authorizerFn, {
      authorizerName: `slack-${stage}-authorizer`,
      identitySource: ["route.request.querystring.token"],
    });

    const handlers = {
      connect: fn("connect"),
      disconnect: fn("disconnect"),
      default: fn("default"),
      // Web Push to offline recipients: subscriptions table + the VAPID parameter.
      message: fn("message", {
        PUSH_SUBSCRIPTIONS_TABLE: data.pushSubscriptions.tableName,
        VAPID_PARAMETER: vapidParameterName(stage),
      }),
      history: fn("history"),
      channel: fn("channel"),
      presign: fn("presign"),
      typing: fn("typing"),
      user: fn("user"),
      react: fn("react"),
      call: fn("call"),
      ping: fn("ping"),
      read: fn("read"),
      edit: fn("edit"),
      pin: fn("pin"),
    } satisfies Record<Exclude<Handler, "authorizer">, NodejsFunction>;

    const integration = (name: keyof typeof handlers) =>
      new WebSocketLambdaIntegration(`${name}Integration`, handlers[name]);

    this.webSocketApi.addRoute("$connect", { integration: integration("connect"), authorizer });
    this.webSocketApi.addRoute("$disconnect", { integration: integration("disconnect") });
    this.webSocketApi.addRoute("$default", { integration: integration("default") });
    for (const action of CLIENT_ACTIONS) {
      this.webSocketApi.addRoute(action, { integration: integration(action) });
    }

    // --- Permissions (least privilege: only the actions each handler calls) ---
    const { connections, messages, channels, users } = data;

    connections.grant(handlers.connect, "dynamodb:PutItem");
    users.grant(handlers.connect, "dynamodb:UpdateItem");
    connections.grant(handlers.disconnect, "dynamodb:DeleteItem");
    // Presence: both announce user.connected / user.disconnected to live
    // connections (Scan), dropping stale ones on 410 Gone (DeleteItem).
    connections.grant(handlers.connect, "dynamodb:Scan", "dynamodb:DeleteItem");
    connections.grant(handlers.disconnect, "dynamodb:Scan");

    // Route handlers resolve the caller from the authorizer context and fall
    // back to the connection row (GetItem).
    const routeHandlers = [
      handlers.message,
      handlers.history,
      handlers.channel,
      handlers.presign,
      handlers.user,
      handlers.react,
      handlers.call,
      handlers.typing,
      handlers.read,
      handlers.edit,
      handlers.pin,
    ];
    for (const h of routeHandlers) connections.grant(h, "dynamodb:GetItem");

    // Broadcasters list live connections and delete stale ones (410 Gone).
    // `call` only relays WebRTC signaling to the peer's connections: it reads no
    // other table and never sees media.
    for (const h of [
      handlers.message,
      handlers.channel,
      handlers.user,
      handlers.react,
      handlers.call,
      handlers.typing,
      handlers.read,
      handlers.edit,
      handlers.pin,
    ]) {
      connections.grant(h, "dynamodb:Scan", "dynamodb:DeleteItem");
    }

    // Every handler that touches a channel's content checks access on its row.
    for (const h of [
      handlers.message,
      handlers.history,
      handlers.presign,
      handlers.react,
      handlers.typing,
      handlers.read,
      handlers.edit,
      handlers.pin,
    ]) {
      channels.grant(h, "dynamodb:GetItem");
    }
    // read: the caller's watermark lives on the channel row (one conditional UpdateItem).
    channels.grant(handlers.read, "dynamodb:UpdateItem");
    // message: the channel's `lastMessageAt`, which orders the sidebar (conditional UpdateItem).
    channels.grant(handlers.message, "dynamodb:UpdateItem");
    // edit: SET text on the caller's own message (conditional UpdateItem).
    messages.grant(handlers.edit, "dynamodb:UpdateItem");
    // Board files (`attachments/<boardId>/…`) are gated by board membership.
    data.boards.grant(handlers.presign, "dynamodb:GetItem");
    // PutItem the message; GetItem the one it replies to (for its snapshot); Query the
    // channel's newest messages so a retried send (same clientId) isn't stored twice;
    // UpdateItem the parent's reply counters, written with a thread reply in one
    // TransactWriteItems (IAM checks each item's own action: without it every reply
    // is denied).
    messages.grant(
      handlers.message,
      "dynamodb:PutItem",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    );
    // Push: the sender's display name (GetItem), @mention lookup (Scan), each
    // recipient's devices (Query) and dropping expired ones (DeleteItem).
    users.grant(handlers.message, "dynamodb:GetItem", "dynamodb:Scan");
    data.pushSubscriptions.grant(handlers.message, "dynamodb:Query", "dynamodb:DeleteItem");
    grantReadVapid(handlers.message, stage);
    messages.grant(handlers.history, "dynamodb:Query");
    channels.grant(
      handlers.channel,
      "dynamodb:Scan",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    );
    // Deleting a channel or DM removes its messages too.
    messages.grant(handlers.channel, "dynamodb:Query", "dynamodb:BatchWriteItem");
    users.grant(handlers.channel, "dynamodb:BatchGetItem"); // invitees must exist
    // Project channels: link a board the caller can see (GetItem) or create one in
    // the same transaction as the channel (PutItem on the board and member rows).
    data.boards.grant(handlers.channel, "dynamodb:GetItem", "dynamodb:PutItem");
    // user: the directory (Scan), your display name and pinned chats (GetItem/UpdateItem);
    // for a guest, the boards they're on decide whose names they get (Query + BatchGetItem).
    users.grant(handlers.user, "dynamodb:Scan", "dynamodb:GetItem", "dynamodb:UpdateItem");
    data.boards.grant(handlers.user, "dynamodb:Query", "dynamodb:BatchGetItem");
    // Pinning checks you can see the conversation.
    channels.grant(handlers.user, "dynamodb:GetItem");
    // Phase 38, the conversation's files/links/pins index (`channel-media`): a message
    // with files or links is stored in one transaction with its rows (PutItem); an
    // edit rewrites its link rows (BatchWriteItem); deleting a conversation removes
    // its rows (Query + BatchWriteItem).
    data.channelMedia.grant(handlers.message, "dynamodb:PutItem");
    data.channelMedia.grant(handlers.edit, "dynamodb:BatchWriteItem");
    data.channelMedia.grant(handlers.channel, "dynamodb:Query", "dynamodb:BatchWriteItem");
    // pin: the message (GetItem, then UpdateItem), its pin row (PutItem/DeleteItem) and
    // the channel's pinCount (UpdateItem), all in one transaction.
    messages.grant(handlers.pin, "dynamodb:GetItem", "dynamodb:UpdateItem");
    data.channelMedia.grant(handlers.pin, "dynamodb:PutItem", "dynamodb:DeleteItem");
    channels.grant(handlers.pin, "dynamodb:UpdateItem");
    // react: ADD/DELETE on the reaction set; GetItem for no-op removals.
    messages.grant(handlers.react, "dynamodb:UpdateItem", "dynamodb:GetItem");

    handlers.presign.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [props.attachments.arnForObjects("attachments/*")],
      }),
    );
    // history and message sign download URLs for inline attachments: a URL only
    // works if the credentials that signed it may read the object.
    for (const h of [handlers.history, handlers.message]) {
      h.addToRolePolicy(
        new PolicyStatement({
          actions: ["s3:GetObject"],
          resources: [props.attachments.arnForObjects("attachments/*")],
        }),
      );
    }
    // ListBucket only so HeadObject on a missing key answers 404 instead of 403.
    handlers.presign.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [props.attachments.bucketArn],
        conditions: { StringLike: { "s3:prefix": ["attachments/*"] } },
      }),
    );

    // Channel calls (Phase 36): `call` keeps the room rows (start, join, leave,
    // list), checks the caller may use the channel (GetItem) and notes the
    // seat on the caller's connection row (UpdateItem) for `$disconnect`,
    // which frees it: the room row (UpdateItem, DeleteItem when the last one
    // leaves) and the channel row for who to tell (GetItem).
    data.callRooms.grant(
      handlers.call,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Scan",
    );
    channels.grant(handlers.call, "dynamodb:GetItem");
    connections.grant(handlers.call, "dynamodb:UpdateItem");
    data.callRooms.grant(handlers.disconnect, "dynamodb:UpdateItem", "dynamodb:DeleteItem");
    channels.grant(handlers.disconnect, "dynamodb:GetItem");

    // ping: stamps or clears `activeAt` on the caller's own connection row
    // (conditional UpdateItem), and answers a probe with `pong` (Phase 25).
    connections.grant(handlers.ping, "dynamodb:UpdateItem");

    // Every handler that replies to the sender or broadcasts uses @connections.
    for (const h of [
      handlers.default,
      handlers.connect,
      handlers.disconnect,
      handlers.ping,
      ...routeHandlers,
    ]) {
      this.webSocketApi.grantManageConnections(h);
    }
  }
}
