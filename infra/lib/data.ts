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
  /**
   * AI Notes hub (Phase 29): one pointer per person to each AI notes card
   * (`userId` + the card's message `sk`, which orders by time), so "all my
   * notes, newest first" is one query; the cards stay in `messages`.
   */
  readonly meetingNotes: Table;
  /**
   * Channel calls (Phase 36): one row per channel with a call going on (who
   * is in it, through which connection). Rows expire (`expiresAt`) as a
   * safety net; the call Lambda and `$disconnect` keep it current.
   */
  readonly callRooms: Table;

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
    this.vacationBalances.addGlobalSecondaryIndex({
      indexName: "byYear",
      partitionKey: { name: "year", type: AttributeType.STRING },
      sortKey: { name: "userId", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.meetingNotes = new Table(this, "MeetingNotes", {
      ...common,
      tableName: `slack-${props.stage}-meeting-notes`,
      partitionKey: { name: "userId", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
    });

    this.callRooms = new Table(this, "CallRooms", {
      ...common,
      tableName: `slack-${props.stage}-call-rooms`,
      partitionKey: { name: "channelId", type: AttributeType.STRING },
      timeToLiveAttribute: "expiresAt",
    });
  }
}
