import { fileURLToPath } from "node:url";
import { ArnFormat, Duration, Stack } from "aws-cdk-lib";
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
import { StartingPosition } from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { VAULT_METADATA_ATTRIBUTES, VAULT_PIN_ATTRIBUTES } from "@mindfultech/shared";
import { Construct } from "constructs";
import type { Api } from "./api";
import type { Auth } from "./auth";
import type { Data } from "./data";
import { LAMBDA_ARCHITECTURE, LAMBDA_BUNDLING, LAMBDA_MEMORY_MB, LAMBDA_RUNTIME } from "./lambda";
import {
  elevenLabsKeyParameterName,
  elevenLabsVoiceParameterName,
  githubActionsTokenParameterName,
  insightsOwnersParameterName,
  githubTokenParameterName,
  openaiKeyParameterName,
  removalPolicyFor,
  vapidParameterName,
  type Stage,
} from "./stage";
import { grantReadParameter, grantReadVapid } from "./vapid";

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
  // Phase 55: invite an external to a private channel by email (same Cognito path).
  { method: HttpMethod.POST, path: "/channels/{channelId}/invites" },
  { method: HttpMethod.GET, path: "/boards/{id}/tasks" },
  { method: HttpMethod.POST, path: "/boards/{id}/tasks" },
  // Phase 29: an AI notes card's action items, all at once.
  { method: HttpMethod.POST, path: "/boards/{id}/tasks/from-notes" },
  { method: HttpMethod.PUT, path: "/tasks/{taskId}" },
  { method: HttpMethod.DELETE, path: "/tasks/{taskId}" },
  // Phase 65: an admin hands the task to the AI.
  { method: HttpMethod.POST, path: "/tasks/{taskId}/ai" },
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
  // Phase 46: filing older notes under a category and topics.
  { method: HttpMethod.POST, path: "/notes/classify" },
  // Phase 50: meeting topics, chosen by the people in the call.
  { method: HttpMethod.GET, path: "/notes/topics" },
  { method: HttpMethod.PUT, path: "/notes/{callId}/topic" },
  // Phase 40: the recording, the full notes, and private questions about them.
  { method: HttpMethod.PUT, path: "/calls/{callId}/audio" },
  { method: HttpMethod.GET, path: "/notes/{callId}" },
  { method: HttpMethod.POST, path: "/notes/{callId}/ask" },
];

/**
 * Phase 43: one clip of a call's audio to OpenAI Whisper, from its own Lambda
 * (the only one that holds the OpenAI key).
 */
export const CALL_TRANSCRIBE_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.POST, path: "/calls/{callId}/clips" },
];

/** Phase 58: a voice message's transcript, on demand (its own Lambda: the OpenAI key, S3 reads). */
export const MESSAGE_TRANSCRIBE_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.POST, path: "/messages/{channelId}/{sk}/transcribe" },
];

/**
 * AI News (Phase 35b): the latest AI articles from a few publishers, read live
 * from their feeds by a stateless Lambda with no data permissions at all.
 */
export const NEWS_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/news" },
  // Phase 63: a shared link's preview, read by the same data-less Lambda.
  { method: HttpMethod.GET, path: "/link-preview" },
];

/**
 * AI Insights (Phase 39): the morning's analysis of the news, written by a
 * scheduled worker; "Refresh news" (`POST /news/refresh`) starts a fresh one
 * at once (members at most every 5 minutes), as did an admin's
 * `POST /news/insights` (kept for tabs opened before it).
 */
export const NEWS_INSIGHTS_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/news/insights" },
  { method: HttpMethod.POST, path: "/news/insights" },
  { method: HttpMethod.POST, path: "/news/refresh" },
  // Phase 50: "Pregunta a la IA", questions about the day's news.
  { method: HttpMethod.POST, path: "/news/ask" },
];

/**
 * When the morning analysis runs: 06:00 in Ecuador (UTC-5, no daylight
 * saving), i.e. `NEWS_INSIGHTS_LOCAL_TIME` in `NEWS_INSIGHTS_TIME_ZONE` of
 * @mindfultech/shared, which the view shows.
 */
export const NEWS_INSIGHTS_SCHEDULE = { hour: "11", minute: "0" };

/**
 * The notes model: Claude Haiku 5.5 on Amazon Bedrock, as the US cross-region
 * inference profile the workers invoke (`NOTES_MODEL` in backend/src/lib/callNotes.ts).
 * Through the standard runtime (`bedrock:InvokeModel`), not the Mantle endpoint:
 * Mantle doesn't serve Haiku 5.5 for this account.
 */
export const NOTES_MODEL_ID = "us.anthropic.claude-haiku-5-5";

/** The foundation model behind `NOTES_MODEL_ID`, which the profile routes to in each US region. */
export const NOTES_FOUNDATION_MODEL_ID = "anthropic.claude-haiku-5-5";

/**
 * What `bedrock:InvokeModel` is granted on: the inference profile in the
 * stack's account and region, and the foundation model in whichever region
 * the profile routes the request to (foundation-model ARNs carry no account).
 */
export function notesModelResources(stack: Stack): string[] {
  return [
    `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${NOTES_MODEL_ID}`,
    `arn:aws:bedrock:*::foundation-model/${NOTES_FOUNDATION_MODEL_ID}`,
  ];
}

/**
 * Deleting messages (Phase 32), by their author or an admin; a conversation's
 * files, links and pinned messages (Phase 38). Their own small Lambda.
 */
export const MESSAGES_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.DELETE, path: "/messages/{channelId}/{sk}" },
  { method: HttpMethod.GET, path: "/channels/{channelId}/files" },
  // Phase 61: the image gallery around an image (the messages table's sparse index).
  { method: HttpMethod.GET, path: "/channels/{channelId}/media" },
  { method: HttpMethod.GET, path: "/channels/{channelId}/links" },
  { method: HttpMethod.GET, path: "/channels/{channelId}/pins" },
  // Phase 60: the channel's time log (hours per person, rates for admins).
  { method: HttpMethod.GET, path: "/channels/{channelId}/time" },
  { method: HttpMethod.POST, path: "/channels/{channelId}/time" },
  { method: HttpMethod.DELETE, path: "/channels/{channelId}/time/{date}/{entryId}" },
  { method: HttpMethod.PUT, path: "/channels/{channelId}/time/rates/{userId}" },
];

/** Message search (Phase 42): its own small Lambda, reading the index and the messages. */
export const SEARCH_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/search" },
];

/**
 * AI Skills (Phase 44): the catalog of Claude Code skills, its GitHub import,
 * generation (Claude Haiku 5.5) and zip downloads, from one Lambda.
 */
/** Platform Insights (Phase 64): the owners' view of how the team uses the app. */
export const PLATFORM_INSIGHTS_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/platform-insights/access" },
  { method: HttpMethod.GET, path: "/platform-insights" },
  { method: HttpMethod.POST, path: "/platform-insights" },
];

/** Phase 62: the team panel (admins only): list accounts, invite staff/admins, change roles. */
export const ADMIN_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/admin/users" },
  { method: HttpMethod.POST, path: "/admin/users" },
  { method: HttpMethod.PUT, path: "/admin/users/{userId}/role" },
];

/** AI Tech Radar (Phase 56): read by the team, changed by admins and the scanner. */
export const RADAR_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/radar" },
  { method: HttpMethod.POST, path: "/radar/blips" },
  { method: HttpMethod.PUT, path: "/radar/blips/{id}" },
  { method: HttpMethod.DELETE, path: "/radar/blips/{id}" },
  { method: HttpMethod.POST, path: "/radar/proposals/{id}/apply" },
  { method: HttpMethod.POST, path: "/radar/proposals/{id}/dismiss" },
  { method: HttpMethod.POST, path: "/radar/scan" },
];

/** The radar scan runs after the morning's AI Insights (06:30 in Ecuador). */
export const RADAR_SCAN_SCHEDULE = { hour: "11", minute: "30" };

/** Phase 60: the Discovery Engine, daily at 06:00 UTC (01:00 in Ecuador). */
export const RADAR_DISCOVERY_SCHEDULE = { hour: "6", minute: "0" };

export const SKILLS_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/skills" },
  { method: HttpMethod.POST, path: "/skills" },
  { method: HttpMethod.GET, path: "/skills/{id}" },
  { method: HttpMethod.DELETE, path: "/skills/{id}" },
  { method: HttpMethod.GET, path: "/skills/{id}/download" },
  { method: HttpMethod.POST, path: "/skills/import-github" },
  { method: HttpMethod.POST, path: "/skills/generate" },
];

/**
 * Vault (Phase 45): the team's passwords, encrypted with KMS. Lists are
 * metadata only; `reveal` decrypts one password. Phase 46: who sees which
 * secret (admins all; staff theirs and those shared with them), and the
 * 4-digit PIN that unlocks the Vault and every reveal.
 */
export const VAULT_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/vault" },
  { method: HttpMethod.POST, path: "/vault" },
  { method: HttpMethod.GET, path: "/vault/channels/{channelId}" },
  { method: HttpMethod.POST, path: "/vault/reveal/{secretId}" },
  { method: HttpMethod.PUT, path: "/vault/secrets/{secretId}" },
  { method: HttpMethod.DELETE, path: "/vault/secrets/{secretId}" },
  { method: HttpMethod.GET, path: "/vault/pin" },
  { method: HttpMethod.POST, path: "/vault/pin" },
  { method: HttpMethod.POST, path: "/vault/pin/verify" },
  { method: HttpMethod.DELETE, path: "/vault/pin/{userId}" },
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
  /** `call-transcribe`: a call's audio clip to Whisper, keeping only the text (Phase 43). */
  readonly callTranscribeHandler: NodejsFunction;
  /** `message-transcribe`: a voice message to Whisper, the text kept on the message (Phase 58). */
  readonly messageTranscribeHandler: NodejsFunction;
  /** `messages`: deleting a message (Phase 32). */
  readonly messagesHandler: NodejsFunction;
  /** `news`: the AI News proxy (Phase 35b); no table, bucket or parameter. */
  readonly newsHandler: NodejsFunction;
  /** `search`: message search (Phase 42). */
  readonly searchHandler: NodejsFunction;
  /** `search-indexer`: keeps the search index in step with the messages table's stream. */
  readonly searchIndexer: NodejsFunction;
  /** `news-insights`: the latest analysis, and an admin's request for a new one (Phase 39). */
  readonly newsInsightsHandler: NodejsFunction;
  /** `news-insights-worker`: writes the day's analysis (the morning schedule, or on request). */
  readonly newsInsightsWorker: NodejsFunction;
  /** `skills`: the AI Skills catalog (Phase 44). */
  readonly skillsHandler: NodejsFunction;
  /** `vault`: the team's passwords (Phase 45), the only code that can use the Vault key. */
  readonly vaultHandler: NodejsFunction;
  /** Phase 62: the team panel (admins invite staff and admins, change roles). */
  readonly adminUsersHandler: NodejsFunction;
  /** Phase 56: the AI Tech Radar's endpoints, and the daily scan of the news for updates. */
  readonly radarHandler: NodejsFunction;
  /** Phase 64: reads counts across the tables and asks the model; owners only. */
  readonly platformInsightsHandler: NodejsFunction;
  readonly radarScanWorker: NodejsFunction;
  /** Phase 60: new technologies from the stored AI news and Hacker News, as proposals. */
  readonly radarDiscoveryEngine: NodejsFunction;
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
        runtime: LAMBDA_RUNTIME,
        architecture: LAMBDA_ARCHITECTURE,
        memorySize: LAMBDA_MEMORY_MB,
        timeout,
        environment: { STAGE: stage, LOG_LEVEL: "info", ...environment },
        projectRoot: REPO_ROOT,
        depsLockFilePath: `${REPO_ROOT}pnpm-lock.yaml`,
        bundling: LAMBDA_BUNDLING,
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
      // Phase 65: where the AI's workflow lives, and the token that starts it.
      AI_TASK_REPOSITORY: String(this.node.tryGetContext("githubRepository") ?? "crpozo/slack"),
      GITHUB_ACTIONS_TOKEN_PARAMETER: githubActionsTokenParameterName(stage),
    });
    // AI News (Phase 35b; several sources since Phase 41): reads public RSS and
    // Atom feeds over the internet and keeps the list in memory; deliberately
    // given no environment and no grants, so it can't touch any table or
    // bucket. Each feed gets 4 s (8 with a second address); the Lambda 15.
    this.newsHandler = lambda("NewsFn", "news", {}, Duration.seconds(15));
    // AI Insights (Phase 39): the worker reads the feed and the model, and
    // writes one row; the endpoint reads that row and, for admins, starts the
    // worker. The feed gets 5 s, the model up to 50; the worker 2 minutes.
    this.newsInsightsWorker = lambda(
      "NewsInsightsWorkerFn",
      "news-insights-worker",
      {
        NEWS_INSIGHTS_TABLE: data.newsInsights.tableName,
        // Phase 54: the summary in audio goes to the attachments bucket (news-audio/).
        ATTACHMENTS_BUCKET: props.attachments.bucketName,
        // Phase 61: ElevenLabs reads the summary when its key exists (else Polly).
        ELEVENLABS_API_KEY_PARAMETER: elevenLabsKeyParameterName(stage),
        ELEVENLABS_VOICE_ID_PARAMETER: elevenLabsVoiceParameterName(stage),
      },
      // Phase 49: one streamed request of up to 5 minutes (high effort, 40 stories).
      Duration.minutes(6),
    );
    // A failed run is tried once more, not twice: each is several minutes of model time.
    this.newsInsightsWorker.configureAsyncInvoke({
      retryAttempts: 1,
      maxEventAge: Duration.hours(1),
    });
    // AI Skills (Phase 44): the catalog, GitHub over the internet, and the model
    // for "Generar con IA" (one request in API Gateway's 30 s).
    this.skillsHandler = lambda(
      "SkillsFn",
      "skills",
      {
        SKILLS_TABLE: data.skills.tableName,
        USERS_TABLE: data.users.tableName,
        GITHUB_TOKEN_PARAMETER: githubTokenParameterName(stage),
      },
      Duration.seconds(30),
    );
    // Vault (Phase 45): KMS and DynamoDB, and the chat for `/secret` cards.
    this.vaultHandler = lambda("VaultFn", "vault", {
      VAULT_TABLE: data.vault.tableName,
      VAULT_KEY_ID: data.vaultKey.keyArn,
      CHANNELS_TABLE: data.channels.tableName,
      USERS_TABLE: data.users.tableName,
      MESSAGES_TABLE: data.messages.tableName,
      CONNECTIONS_TABLE: data.connections.tableName,
      WS_ENDPOINT: wsApi.webSocketStage.callbackUrl,
    });
    // AI Tech Radar (Phase 56): the worker reads the feeds and asks the model;
    // the endpoint reads and writes the table and, for admins, starts the worker.
    this.radarScanWorker = lambda(
      "RadarScanWorkerFn",
      "radar-scan-worker",
      { TECH_RADAR_TABLE: data.techRadar.tableName },
      Duration.minutes(3),
    );
    this.radarScanWorker.configureAsyncInvoke({ retryAttempts: 1, maxEventAge: Duration.hours(1) });
    new Rule(this, "RadarScanSchedule", {
      ruleName: `slack-${stage}-radar-scan`,
      description: "Scans the AI news for Tech Radar updates",
      schedule: Schedule.cron(RADAR_SCAN_SCHEDULE),
      targets: [new LambdaFunction(this.radarScanWorker, { retryAttempts: 1 })],
    });
    // Phase 60: the Discovery Engine reads the stored AI news and Hacker News
    // (the public API, over the internet like the news feeds) and files
    // proposals; it never writes a blip.
    this.radarDiscoveryEngine = lambda(
      "RadarDiscoveryEngineFn",
      "radar-discovery-engine",
      {
        TECH_RADAR_TABLE: data.techRadar.tableName,
        NEWS_INSIGHTS_TABLE: data.newsInsights.tableName,
      },
      Duration.minutes(3),
    );
    this.radarDiscoveryEngine.configureAsyncInvoke({
      retryAttempts: 1,
      maxEventAge: Duration.hours(1),
    });
    new Rule(this, "RadarDiscoverySchedule", {
      ruleName: `slack-${stage}-radar-discovery`,
      description: "Discovers new technologies for the Tech Radar's proposals",
      schedule: Schedule.cron(RADAR_DISCOVERY_SCHEDULE),
      targets: [new LambdaFunction(this.radarDiscoveryEngine, { retryAttempts: 1 })],
    });
    this.platformInsightsHandler = lambda(
      "PlatformInsightsFn",
      "platform-insights",
      {
        USERS_TABLE: data.users.tableName,
        CHANNELS_TABLE: data.channels.tableName,
        MESSAGES_TABLE: data.messages.tableName,
        TASKS_TABLE: data.tasks.tableName,
        TIME_LOG_TABLE: data.timeLog.tableName,
        // The report is kept in a partition of its own of the news-insights table.
        NEWS_INSIGHTS_TABLE: data.newsInsights.tableName,
        INSIGHTS_OWNERS_PARAMETER: insightsOwnersParameterName(stage),
      },
      // The asynchronous run reads every table and waits for the model.
      Duration.seconds(150),
    );
    this.adminUsersHandler = lambda("AdminUsersFn", "admin-users", {
      USERS_TABLE: data.users.tableName,
      USER_POOL_ID: auth.userPool.userPoolId,
    });
    this.radarHandler = lambda("RadarFn", "radar", {
      TECH_RADAR_TABLE: data.techRadar.tableName,
      RADAR_WORKER_FUNCTION: this.radarScanWorker.functionName,
      RADAR_DISCOVERY_FUNCTION: this.radarDiscoveryEngine.functionName,
    });
    this.newsInsightsHandler = lambda(
      "NewsInsightsFn",
      "news-insights",
      {
        NEWS_INSIGHTS_TABLE: data.newsInsights.tableName,
        INSIGHTS_WORKER_FUNCTION: this.newsInsightsWorker.functionName,
        // Phase 54: signs the URL of the summary's audio.
        ATTACHMENTS_BUCKET: props.attachments.bucketName,
      },
      // Phase 50: a question may read the feeds and then ask the model (API Gateway allows 30 s).
      Duration.seconds(29),
    );
    new Rule(this, "NewsInsightsSchedule", {
      ruleName: `slack-${stage}-news-insights`,
      description: "Writes the morning's AI Insights on the AI news",
      schedule: Schedule.cron(NEWS_INSIGHTS_SCHEDULE), // daily, 06:00 in Ecuador
      targets: [new LambdaFunction(this.newsInsightsWorker, { retryAttempts: 2 })],
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
    // Phase 40: polished minutes run about as long as the call's transcript,
    // streamed for minutes on a long call.
    this.callNotesWorker = lambda(
      "CallNotesWorkerFn",
      "call-notes-worker",
      {
        MESSAGES_TABLE: data.messages.tableName,
        USERS_TABLE: data.users.tableName,
        CONNECTIONS_TABLE: data.connections.tableName,
        NOTE_DETAILS_TABLE: data.noteDetails.tableName,
        WS_ENDPOINT: wsApi.webSocketStage.callbackUrl,
      },
      Duration.minutes(15),
    );
    // Errors become a failed card inside the worker; an async retry would only repeat them.
    this.callNotesWorker.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.hours(1) });
    // Phase 40: answering a question about a call (Claude) takes up to API Gateway's 30 s.
    this.callNotesHandler = lambda(
      "CallNotesFn",
      "call-notes",
      {
        MESSAGES_TABLE: data.messages.tableName,
        CHANNELS_TABLE: data.channels.tableName,
        CONNECTIONS_TABLE: data.connections.tableName,
        USERS_TABLE: data.users.tableName,
        WS_ENDPOINT: wsApi.webSocketStage.callbackUrl,
        NOTES_WORKER_FUNCTION: this.callNotesWorker.functionName,
        MEETING_NOTES_TABLE: data.meetingNotes.tableName,
        NOTE_DETAILS_TABLE: data.noteDetails.tableName,
      },
      Duration.seconds(30),
    );

    // Phase 43: a clip (up to 4 MB) to Whisper takes up to 25 s, inside API
    // Gateway's 30. The audio stays in memory; the key comes from Parameter Store.
    this.callTranscribeHandler = lambda(
      "CallTranscribeFn",
      "call-transcribe",
      {
        CHANNELS_TABLE: data.channels.tableName,
        NOTE_DETAILS_TABLE: data.noteDetails.tableName,
        OPENAI_API_KEY_PARAMETER: openaiKeyParameterName(stage),
      },
      Duration.seconds(30),
    );
    // Phase 58: a voice message (up to 24 MB) from S3 to Whisper, in memory,
    // inside API Gateway's 30 s; the same key as the calls' clips.
    this.messageTranscribeHandler = lambda(
      "MessageTranscribeFn",
      "message-transcribe",
      {
        CHANNELS_TABLE: data.channels.tableName,
        MESSAGES_TABLE: data.messages.tableName,
        ATTACHMENTS_BUCKET: props.attachments.bucketName,
        OPENAI_API_KEY_PARAMETER: openaiKeyParameterName(stage),
      },
      Duration.seconds(30),
    );

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
      NOTE_DETAILS_TABLE: data.noteDetails.tableName,
      CHANNEL_MEDIA_TABLE: data.channelMedia.tableName,
      TIME_LOG_TABLE: data.timeLog.tableName,
      ATTACHMENTS_BUCKET: props.attachments.bucketName,
      WS_ENDPOINT: wsApi.webSocketStage.callbackUrl,
    });
    // Message search (Phase 42): the endpoint reads the conversations (to know
    // which the caller sees), the index and the matching messages; the indexer
    // follows the messages table's stream and writes only the index.
    this.searchHandler = lambda("SearchFn", "search", {
      CHANNELS_TABLE: data.channels.tableName,
      MESSAGES_TABLE: data.messages.tableName,
      MESSAGE_SEARCH_TABLE: data.messageSearch.tableName,
    });
    this.searchIndexer = lambda(
      "SearchIndexerFn",
      "search-indexer",
      { MESSAGE_SEARCH_TABLE: data.messageSearch.tableName },
      Duration.seconds(60),
    );
    this.searchIndexer.addEventSource(
      new DynamoEventSource(data.messages, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: Duration.seconds(1),
        // A batch that keeps failing is split to find the bad record, retried a
        // few times, then skipped (the index misses one message, nothing else).
        bisectBatchOnError: true,
        retryAttempts: 5,
        reportBatchItemFailures: false,
      }),
    );
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
        // x-vault-session: an unlocked Vault (Phase 46).
        allowHeaders: ["authorization", "content-type", "x-vault-session"],
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
    const searchIntegration = new HttpLambdaIntegration("SearchIntegration", this.searchHandler);
    for (const { method, path } of SEARCH_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: searchIntegration });
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
    const callTranscribeIntegration = new HttpLambdaIntegration(
      "CallTranscribeIntegration",
      this.callTranscribeHandler,
    );
    for (const { method, path } of CALL_TRANSCRIBE_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: callTranscribeIntegration });
    }
    const messageTranscribeIntegration = new HttpLambdaIntegration(
      "MessageTranscribeIntegration",
      this.messageTranscribeHandler,
    );
    for (const { method, path } of MESSAGE_TRANSCRIBE_ROUTES) {
      this.httpApi.addRoutes({
        path,
        methods: [method],
        integration: messageTranscribeIntegration,
      });
    }
    const calendarIntegration = new HttpLambdaIntegration(
      "CalendarIntegration",
      this.calendarHandler,
    );
    for (const { method, path } of CALENDAR_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: calendarIntegration });
    }
    const newsIntegration = new HttpLambdaIntegration("NewsIntegration", this.newsHandler);
    for (const { method, path } of NEWS_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: newsIntegration });
    }
    const newsInsightsIntegration = new HttpLambdaIntegration(
      "NewsInsightsIntegration",
      this.newsInsightsHandler,
    );
    for (const { method, path } of NEWS_INSIGHTS_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: newsInsightsIntegration });
    }
    const skillsIntegration = new HttpLambdaIntegration("SkillsIntegration", this.skillsHandler);
    for (const { method, path } of SKILLS_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: skillsIntegration });
    }
    const platformInsightsIntegration = new HttpLambdaIntegration(
      "PlatformInsightsIntegration",
      this.platformInsightsHandler,
    );
    for (const { method, path } of PLATFORM_INSIGHTS_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: platformInsightsIntegration });
    }
    const adminIntegration = new HttpLambdaIntegration(
      "AdminUsersIntegration",
      this.adminUsersHandler,
    );
    for (const { method, path } of ADMIN_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: adminIntegration });
    }
    const radarIntegration = new HttpLambdaIntegration("RadarIntegration", this.radarHandler);
    for (const { method, path } of RADAR_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: radarIntegration });
    }
    const vaultIntegration = new HttpLambdaIntegration("VaultIntegration", this.vaultHandler);
    for (const { method, path } of VAULT_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration: vaultIntegration });
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
    grantReadParameter(this.handler, githubActionsTokenParameterName(stage));
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
    // Phase 50: pointers by topic (Query on `byTopic`), whose pointers exist
    // (BatchGetItem) and filing them (UpdateItem, in the topic's transaction).
    data.meetingNotes.grant(
      this.callNotesHandler,
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:BatchGetItem",
      "dynamodb:UpdateItem",
    );
    data.connections.grant(this.callNotesHandler, "dynamodb:Scan", "dynamodb:DeleteItem");
    wsApi.webSocketApi.grantManageConnections(this.callNotesHandler);
    this.callNotesWorker.grantInvoke(this.callNotesHandler);
    // call-notes-worker: settling the card (UpdateItem), its push, and the model on
    // Amazon Bedrock (no model is provisioned here). Phase 40: it reads the call's
    // transcript (GetItem) and stores the polished minutes (PutItem).
    const notesModelPolicy = (streaming = false) =>
      new PolicyStatement({
        // The worker streams its long answer (Phase 40), which is its own action.
        actions: [
          "bedrock:InvokeModel",
          ...(streaming ? ["bedrock:InvokeModelWithResponseStream"] : []),
        ],
        resources: notesModelResources(Stack.of(this)),
      });
    data.users.grant(this.callNotesWorker, "dynamodb:GetItem");
    data.messages.grant(this.callNotesWorker, "dynamodb:UpdateItem");
    data.noteDetails.grant(this.callNotesWorker, "dynamodb:GetItem", "dynamodb:PutItem");
    data.connections.grant(this.callNotesWorker, "dynamodb:Scan", "dynamodb:DeleteItem");
    wsApi.webSocketApi.grantManageConnections(this.callNotesWorker);
    this.callNotesWorker.addToRolePolicy(notesModelPolicy(true));
    // Phase 40, call-notes: the speakers' names for the stored transcript (users
    // GetItem); the transcript row (PutItem, with the card), reading the notes and
    // questions (GetItem, Query) and storing a question (PutItem); attaching the
    // recording (messages UpdateItem, granted above); answering on Amazon Bedrock.
    data.users.grant(this.callNotesHandler, "dynamodb:GetItem");
    data.noteDetails.grant(
      this.callNotesHandler,
      "dynamodb:PutItem",
      "dynamodb:GetItem",
      "dynamodb:Query",
      // Phase 50: clearing a meeting's topic row.
      "dynamodb:DeleteItem",
    );
    this.callNotesHandler.addToRolePolicy(notesModelPolicy());
    // Phase 43, call-transcribe: the DM (GetItem); whether the notes were
    // requested (GetItem), the call's clip counter (UpdateItem) and each
    // clip's text (PutItem); the OpenAI key. No bucket: audio is never stored.
    data.channels.grant(this.callTranscribeHandler, "dynamodb:GetItem");
    data.noteDetails.grant(
      this.callTranscribeHandler,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    );
    grantReadParameter(this.callTranscribeHandler, openaiKeyParameterName(stage));
    // Phase 58, message-transcribe: the conversation (GetItem), the message (GetItem,
    // and UpdateItem for its hold and transcript), its audio (s3:GetObject, files only),
    // the OpenAI key. Nothing else: it can't send, delete or list.
    data.channels.grant(this.messageTranscribeHandler, "dynamodb:GetItem");
    data.messages.grant(this.messageTranscribeHandler, "dynamodb:GetItem", "dynamodb:UpdateItem");
    this.messageTranscribeHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [props.attachments.arnForObjects("attachments/*")],
      }),
    );
    grantReadParameter(this.messageTranscribeHandler, openaiKeyParameterName(stage));

    // news-insights-worker: the day's row (PutItem) and the model on Amazon
    // Bedrock; it reads the feed over the internet. news-insights: the newest
    // row (Query), the refresh cooldown's own row (UpdateItem) and starting
    // the worker.
    // Phase 55: UpdateItem (the audio's claim, and adding the audio to its analysis) and
    // Query (the newest analysis, when only its audio is asked for).
    data.newsInsights.grant(
      this.newsInsightsWorker,
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    );
    // The worker streams its answer (Phase 49): that's its own Bedrock action.
    this.newsInsightsWorker.addToRolePolicy(notesModelPolicy(true));
    // "Pregunta a la IA" (Phase 50): the endpoint asks the model itself (one short answer).
    this.newsInsightsHandler.addToRolePolicy(notesModelPolicy());
    // GetItem: the last failed run (Phase 49b).
    data.newsInsights.grant(
      this.newsInsightsHandler,
      "dynamodb:Query",
      "dynamodb:UpdateItem",
      "dynamodb:GetItem",
    );
    this.newsInsightsWorker.grantInvoke(this.newsInsightsHandler);
    // Phase 56, radar: the endpoint owns the table; the worker adds blips and
    // proposals (never deletes a blip) and asks the model on Bedrock.
    // Phase 62, the team panel: names and new profiles in `users` (Scan, PutItem,
    // UpdateItem); in Cognito, list accounts and groups, create staff/admin
    // accounts (deleting one whose group couldn't be set) and move people in or
    // out of `admins`. Admins only, checked in the handler from the token.
    data.users.grant(
      this.adminUsersHandler,
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    );
    this.adminUsersHandler.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "cognito-idp:ListUsers",
          "cognito-idp:ListUsersInGroup",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
        ],
        resources: [auth.userPool.userPoolArn],
      }),
    );
    data.techRadar.grant(
      this.radarHandler,
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    );
    this.radarScanWorker.grantInvoke(this.radarHandler);
    data.techRadar.grant(
      this.radarScanWorker,
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    );
    this.radarScanWorker.addToRolePolicy(notesModelPolicy());
    // Phase 64, platform insights: read-only on what it counts (it never writes to
    // them), its own rows in the news-insights table, the model, the owners'
    // parameter, and invoking itself for the long run (by name: a grant on the
    // function itself would be a circular dependency).
    data.users.grant(this.platformInsightsHandler, "dynamodb:Scan");
    data.channels.grant(this.platformInsightsHandler, "dynamodb:Scan");
    data.messages.grant(this.platformInsightsHandler, "dynamodb:Query");
    data.tasks.grant(this.platformInsightsHandler, "dynamodb:Scan");
    data.timeLog.grant(this.platformInsightsHandler, "dynamodb:Scan");
    data.newsInsights.grant(this.platformInsightsHandler, "dynamodb:GetItem", "dynamodb:PutItem");
    this.platformInsightsHandler.addToRolePolicy(notesModelPolicy(true));
    grantReadParameter(this.platformInsightsHandler, insightsOwnersParameterName(stage));
    this.platformInsightsHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          Stack.of(this).formatArn({
            service: "lambda",
            resource: "function",
            resourceName: `slack-${stage}-platform-insights`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    // Phase 60, discovery: reads the radar (to skip what it knows) and the
    // stored AI news, writes proposals only, and asks the model on Bedrock.
    this.radarDiscoveryEngine.grantInvoke(this.radarHandler);
    data.techRadar.grant(this.radarDiscoveryEngine, "dynamodb:Query", "dynamodb:PutItem");
    data.newsInsights.grant(this.radarDiscoveryEngine, "dynamodb:Query");
    this.radarDiscoveryEngine.addToRolePolicy(notesModelPolicy());
    // Phase 54: the summary read aloud. The worker asks Amazon Polly for the
    // speech and writes the MP3 under news-audio/; the endpoint only reads
    // there (to sign the page's URL). Nothing else in the bucket is reachable.
    this.newsInsightsWorker.addToRolePolicy(
      new PolicyStatement({ actions: ["polly:SynthesizeSpeech"], resources: ["*"] }),
    );
    // Phase 61: the optional ElevenLabs key and voice (SSM), read only by the worker.
    grantReadParameter(this.newsInsightsWorker, elevenLabsKeyParameterName(stage));
    grantReadParameter(this.newsInsightsWorker, elevenLabsVoiceParameterName(stage));
    this.newsInsightsWorker.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [props.attachments.arnForObjects("news-audio/*")],
      }),
    );
    this.newsInsightsHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [props.attachments.arnForObjects("news-audio/*")],
      }),
    );

    // skills: the catalog (Scan the metadata rows, Query one skill, Get the
    // seed marker, Put and BatchWrite to save and delete), the author's name
    // (users GetItem), the optional GitHub token, and the model for generating.
    data.skills.grant(
      this.skillsHandler,
      "dynamodb:Scan",
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:BatchWriteItem",
    );
    data.users.grant(this.skillsHandler, "dynamodb:GetItem");
    grantReadParameter(this.skillsHandler, githubTokenParameterName(stage));
    this.skillsHandler.addToRolePolicy(notesModelPolicy());

    // vault: one row at a time (Get/Put/Delete), and Scans that ask for the
    // metadata only (IAM checks the attributes requested: a Scan can never
    // read a ciphertext); its channel and a `/secret` card in the chat; on
    // `users`, the saver's name, the team (id and role, for sharing) and the
    // PIN's own attributes, nothing else. KMS: Encrypt and Decrypt on the
    // Vault key only, with the Vault's contexts (passwords, PIN hashes); no
    // GenerateDataKey, ReEncrypt or key administration.
    data.vault.grant(
      this.vaultHandler,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    );
    this.vaultHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:Scan"],
        resources: [data.vault.tableArn],
        conditions: {
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...VAULT_METADATA_ATTRIBUTES] },
        },
      }),
    );
    this.vaultHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["kms:Encrypt", "kms:Decrypt"],
        resources: [data.vaultKey.keyArn],
        conditions: {
          StringEquals: { "kms:EncryptionContext:purpose": ["vault", "vault-pin"] },
        },
      }),
    );
    data.users.grant(this.vaultHandler, "dynamodb:GetItem");
    this.vaultHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [data.users.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...VAULT_PIN_ATTRIBUTES] },
        },
      }),
    );
    this.vaultHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:Scan"],
        resources: [data.users.tableArn],
        conditions: {
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["userId", "role"] },
        },
      }),
    );
    data.channels.grant(this.vaultHandler, "dynamodb:GetItem", "dynamodb:UpdateItem");
    data.messages.grant(this.vaultHandler, "dynamodb:PutItem");
    data.connections.grant(this.vaultHandler, "dynamodb:Scan", "dynamodb:DeleteItem");
    wsApi.webSocketApi.grantManageConnections(this.vaultHandler);

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

    // search (Phase 42): which conversations the caller sees (Scan, < 50 rows), the
    // index (Query) and the candidates (BatchGetItem). search-indexer: the index rows
    // (BatchWriteItem); the event source grants it the stream.
    data.channels.grant(this.searchHandler, "dynamodb:Scan");
    data.messageSearch.grant(this.searchHandler, "dynamodb:Query");
    data.messages.grant(this.searchHandler, "dynamodb:BatchGetItem");
    data.messageSearch.grant(this.searchIndexer, "dynamodb:BatchWriteItem");

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
    // Phase 40: a deleted notes card's transcript, minutes and questions (Query, BatchWriteItem).
    data.noteDetails.grant(this.messagesHandler, "dynamodb:Query", "dynamodb:BatchWriteItem");
    data.connections.grant(this.messagesHandler, "dynamodb:Scan", "dynamodb:DeleteItem");
    wsApi.webSocketApi.grantManageConnections(this.messagesHandler);
    grantDeleteFiles(this.messagesHandler, props.attachments);
    // Phase 38: a conversation's files/links/pins (Query the index; BatchGetItem the
    // pinned messages as they are now; images in Files are signed: s3:GetObject); a
    // deleted message's rows leave the index (BatchWriteItem) and a pinned one lowers
    // the channel's pinCount (UpdateItem).
    data.channelMedia.grant(this.messagesHandler, "dynamodb:Query", "dynamodb:BatchWriteItem");
    // Phase 60, the time log: a channel's rows (Query), one entry or rate (GetItem,
    // PutItem, DeleteItem).
    data.timeLog.grant(
      this.messagesHandler,
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    );
    data.messages.grant(this.messagesHandler, "dynamodb:BatchGetItem");
    data.channels.grant(this.messagesHandler, "dynamodb:UpdateItem");
    this.messagesHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [props.attachments.arnForObjects("attachments/*")],
      }),
    );

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
