import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { Api } from "./api";
import { Auth } from "./auth";
import { Cost } from "./cost";
import { Data } from "./data";
import type { Stage } from "./stage";
import { Storage } from "./storage";
import { Web } from "./web";

export interface SlackStackProps extends StackProps {
  stage: Stage;
}

export class SlackStack extends Stack {
  constructor(scope: Construct, id: string, props: SlackStackProps) {
    super(scope, id, props);
    const { stage } = props;

    const auth = new Auth(this, "Auth", { stage });
    const data = new Data(this, "Data", { stage });
    const storage = new Storage(this, "Storage", { stage });
    const api = new Api(this, "Api", { stage, auth, data, attachments: storage.attachments });
    const web = new Web(this, "Web", { stage, bucket: storage.web });
    new Cost(this, "Cost", {
      stage,
      alertEmail: this.node.tryGetContext("budgetEmail") ?? "carlos@mindfultech.ec",
    });

    new CfnOutput(this, "UserPoolId", { value: auth.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: auth.userPoolClient.userPoolClientId });
    new CfnOutput(this, "WebSocketUrl", { value: api.webSocketStage.url });
    new CfnOutput(this, "CloudFrontUrl", {
      value: `https://${web.distribution.distributionDomainName}`,
    });
    new CfnOutput(this, "AttachmentsBucket", { value: storage.attachments.bucketName });
  }
}
