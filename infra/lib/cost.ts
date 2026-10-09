import { Tags } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { CfnAnomalyMonitor, CfnAnomalySubscription } from "aws-cdk-lib/aws-ce";
import { Construct } from "constructs";
import type { Stage } from "./stage";

interface CostProps {
  stage: Stage;
  /** Recipient of budget and anomaly alerts; required in prod (CDK context `budgetEmail`). */
  alertEmail?: string;
  monthlyLimitUsd?: number;
  /** Alert when an anomaly's total impact reaches this many USD. */
  anomalyThresholdUsd?: number;
}

export class Cost extends Construct {
  /** ARN of the Cost Anomaly Detection monitor (prod only). */
  readonly anomalyMonitorArn?: string;

  constructor(scope: Construct, id: string, props: CostProps) {
    super(scope, id);
    Tags.of(scope).add("project", "slack");

    // Budget and anomaly monitor are account-level: only the permanent stack has them.
    if (props.stage !== "prod") return;

    // Fail fast: a prod stack whose cost alerts go nowhere must not deploy.
    const alertEmail = props.alertEmail?.trim();
    if (!alertEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail)) {
      throw new Error(
        'Missing or invalid CDK context "budgetEmail": SlackProd needs a recipient for ' +
          "its budget and cost anomaly alerts (set it in infra/cdk.json or pass -c budgetEmail=…).",
      );
    }

    new CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "slack-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.monthlyLimitUsd ?? 5, unit: "USD" },
      },
      notificationsWithSubscribers: [80, 100].map((threshold) => ({
        notification: {
          notificationType: "ACTUAL",
          comparisonOperator: "GREATER_THAN",
          threshold,
          thresholdType: "PERCENTAGE",
        },
        subscribers: [{ subscriptionType: "EMAIL", address: alertEmail }],
      })),
    });

    // Watches spend on resources tagged project=slack. The tag must be activated
    // once in Billing → Cost allocation tags for Cost Explorer to see it.
    const monitor = new CfnAnomalyMonitor(this, "AnomalyMonitor", {
      monitorName: "slack-project",
      monitorType: "CUSTOM",
      monitorSpecification: JSON.stringify({
        Tags: { Key: "project", Values: ["slack"], MatchOptions: ["EQUALS"] },
      }),
    });

    this.anomalyMonitorArn = monitor.attrMonitorArn;

    new CfnAnomalySubscription(this, "AnomalySubscription", {
      subscriptionName: "slack-anomalies",
      monitorArnList: [monitor.attrMonitorArn],
      // Email subscribers only support DAILY or WEEKLY digests.
      frequency: "DAILY",
      subscribers: [{ type: "EMAIL", address: alertEmail }],
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
          Values: [String(props.anomalyThresholdUsd ?? 1)],
          MatchOptions: ["GREATER_THAN_OR_EQUAL"],
        },
      }),
    });
  }
}
