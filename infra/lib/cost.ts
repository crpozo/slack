import { Tags } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { Construct } from "constructs";
import type { Stage } from "./stage";

interface CostProps {
  stage: Stage;
  /** Recipient of budget alerts. */
  alertEmail: string;
  monthlyLimitUsd?: number;
}

export class Cost extends Construct {
  constructor(scope: Construct, id: string, props: CostProps) {
    super(scope, id);
    Tags.of(scope).add("project", "slack");

    // The budget is account-wide, so it only lives in the permanent stack.
    if (props.stage !== "prod") return;

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
        subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }],
      })),
    });
  }
}
