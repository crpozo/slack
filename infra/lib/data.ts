import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { removalPolicyFor, type Stage } from "./stage";

export class Data extends Construct {
  readonly messages: Table;
  readonly connections: Table;
  readonly channels: Table;
  readonly users: Table;

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
  }
}
