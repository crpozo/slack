import { AttributeType, BillingMode, ProjectionType, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { removalPolicyFor, type Stage } from "./stage";

export class Data extends Construct {
  readonly messages: Table;
  readonly connections: Table;
  readonly channels: Table;
  readonly users: Table;
  /** Task Manager (Phase 6): board rows + membership rows, see backend/src/handlers/tasks.ts. */
  readonly boards: Table;
  readonly tasks: Table;
  /** Web Push (Phase 8): one row per browser/device that enabled notifications. */
  readonly pushSubscriptions: Table;
  /** Company calendar (Phase 19): meetings, vacation requests and holidays, see backend/src/handlers/calendar.ts. */
  readonly events: Table;
  /** Vacation ledger: one row per person and year (allowance, used, pending). */
  readonly vacationBalances: Table;
  /** One rich-text document per conversation (Phase 24), keyed by channel. */
  readonly canvases: Table;

  constructor(scope: Construct, id: string, props: { stage: Stage }) {
    super(scope, id);
    const common = {
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicyFor(props.stage),
    };

    this.messages = new Table(this, "Messages", {
      ...common,
      tableName: `slack-${props.stage}-messages`,
      partitionKey: { name: "channelId", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      // Secret messages carry `expiresAt` (epoch seconds, 7 days out); nothing else does.
      timeToLiveAttribute: "expiresAt",
    });

    this.connections = new Table(this, "Connections", {
      ...common,
      tableName: `slack-${props.stage}-connections`,
      partitionKey: { name: "connectionId", type: AttributeType.STRING },
      timeToLiveAttribute: "ttl",
    });

    this.channels = new Table(this, "Channels", {
      ...common,
      tableName: `slack-${props.stage}-channels`,
      partitionKey: { name: "channelId", type: AttributeType.STRING },
    });

    // Directory of everyone who has signed in: email + display name (Phase 5.1).
    this.users = new Table(this, "Users", {
      ...common,
      tableName: `slack-${props.stage}-users`,
      partitionKey: { name: "userId", type: AttributeType.STRING },
    });

    this.boards = new Table(this, "Boards", {
      ...common,
      tableName: `slack-${props.stage}-boards`,
      partitionKey: { name: "boardId", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
    });
    // "Which boards is this user on?": one membership row per member.
    this.boards.addGlobalSecondaryIndex({
      indexName: "byUser",
      partitionKey: { name: "userId", type: AttributeType.STRING },
      sortKey: { name: "boardId", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    this.tasks = new Table(this, "Tasks", {
      ...common,
      tableName: `slack-${props.stage}-tasks`,
      partitionKey: { name: "taskId", type: AttributeType.STRING },
    });
    this.pushSubscriptions = new Table(this, "PushSubscriptions", {
      ...common,
      tableName: `slack-${props.stage}-push-subscriptions`,
      partitionKey: { name: "userId", type: AttributeType.STRING },
      // sha256(endpoint): a user can have several devices.
      sortKey: { name: "sk", type: AttributeType.STRING },
    });

    this.tasks.addGlobalSecondaryIndex({
      indexName: "byBoard",
      partitionKey: { name: "boardId", type: AttributeType.STRING },
      sortKey: { name: "createdAt", type: AttributeType.NUMBER },
      projectionType: ProjectionType.ALL,
    });

    this.events = new Table(this, "Events", {
      ...common,
      tableName: `slack-${props.stage}-events`,
      partitionKey: { name: "eventId", type: AttributeType.STRING },
    });
    // "What's on the calendar between these dates?": one query per year the range spans.
    this.events.addGlobalSecondaryIndex({
      indexName: "byYear",
      partitionKey: { name: "year", type: AttributeType.STRING },
      sortKey: { name: "startAt", type: AttributeType.NUMBER },
      projectionType: ProjectionType.ALL,
    });

    this.vacationBalances = new Table(this, "VacationBalances", {
      ...common,
      tableName: `slack-${props.stage}-vacation-balances`,
      partitionKey: { name: "userId", type: AttributeType.STRING },
      sortKey: { name: "year", type: AttributeType.STRING },
    });
    // Admins' overview: everyone's balance for a year.
    this.canvases = new Table(this, "Canvases", {
      ...common,
      tableName: `slack-${props.stage}-canvases`,
      partitionKey: { name: "channelId", type: AttributeType.STRING },
    });

    this.vacationBalances.addGlobalSecondaryIndex({
      indexName: "byYear",
      partitionKey: { name: "year", type: AttributeType.STRING },
      sortKey: { name: "userId", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
  }
}
