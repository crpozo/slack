import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { ARecord, HostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { ApiGatewayv2DomainProperties, CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import type { Construct } from "constructs";
import { Api } from "./api";
import { Auth } from "./auth";
import { GitHubDeployRole } from "./ci";
import { Cost } from "./cost";
import { Data } from "./data";
import { customDomainsEnabled, LOCAL_DEV_ORIGINS, resolveDomainConfig } from "./domain";
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

    // Custom domains only once the (manually validated) certificate exists.
    const domains = resolveDomainConfig(this.node, stage);
    const custom = customDomainsEnabled(domains)
      ? {
          ...domains,
          certificate: Certificate.fromCertificateArn(this, "Certificate", domains.certificateArn),
        }
      : undefined;

    const api = new Api(this, "Api", {
      stage,
      auth,
      data,
      attachments: storage.attachments,
      customDomain: custom && { domainName: custom.wsDomain, certificate: custom.certificate },
    });

    // Team directory for DMs (`email=sub,…`): context `webUsers` or env WEB_USERS.
    const webUsers: unknown = this.node.tryGetContext("webUsers") ?? process.env.WEB_USERS;
    const web = new Web(this, "Web", {
      stage,
      bucket: storage.web,
      skipBuild: this.node.tryGetContext("skipWebBuild") === "true",
      customDomain: custom && { domainName: custom.appDomain, certificate: custom.certificate },
      runtimeConfig: {
        wsUrl: api.url,
        userPoolId: auth.userPool.userPoolId,
        userPoolClientId: auth.userPoolClient.userPoolClientId,
        ...(typeof webUsers === "string" && webUsers ? { users: webUsers } : {}),
      },
    });

    // Presigned uploads/downloads only from the SPA's own origins.
    const cloudFrontOrigin = `https://${web.distribution.distributionDomainName}`;
    storage.allowBrowserOrigins([
      cloudFrontOrigin,
      ...[domains.appDomain, domains.wsDomain].flatMap((d) => (d ? [`https://${d}`] : [])),
      ...LOCAL_DEV_ORIGINS,
    ]);

    // Route 53 alias records when the zone is there; otherwise create the CNAMEs by hand.
    if (custom?.hostedZoneId && custom.hostedZoneName && api.domainName) {
      const zone = HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId: custom.hostedZoneId,
        zoneName: custom.hostedZoneName,
      });
      new ARecord(this, "AppAlias", {
        zone,
        recordName: custom.appDomain,
        target: RecordTarget.fromAlias(new CloudFrontTarget(web.distribution)),
      });
      new ARecord(this, "WsAlias", {
        zone,
        recordName: custom.wsDomain,
        target: RecordTarget.fromAlias(
          new ApiGatewayv2DomainProperties(
            api.domainName.regionalDomainName,
            api.domainName.regionalHostedZoneId,
          ),
        ),
      });
    }

    const alertEmail: string = this.node.tryGetContext("budgetEmail") ?? "carlos@mindfultech.ec";
    new Cost(this, "Cost", { stage, alertEmail });

    if (stage === "prod") {
      const deployRole = new GitHubDeployRole(this, "GitHubDeploy", {
        repository: this.node.tryGetContext("githubRepository") ?? "crpozo/slack",
        branch: "main",
        existingProviderArn:
          this.node.tryGetContext("githubOidcProviderArn") ?? process.env.GITHUB_OIDC_PROVIDER_ARN,
        channelsTable: data.channels,
      });
      new CfnOutput(this, "GitHubDeployRoleArn", {
        value: deployRole.role.roleArn,
        description: "Set as the AWS_DEPLOY_ROLE_ARN variable of the GitHub repository",
      });
    }

    new CfnOutput(this, "UserPoolId", { value: auth.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: auth.userPoolClient.userPoolClientId });
    new CfnOutput(this, "WebSocketUrl", { value: api.url });
    new CfnOutput(this, "CloudFrontUrl", { value: cloudFrontOrigin });
    new CfnOutput(this, "AppUrl", {
      value: custom ? `https://${custom.appDomain}` : cloudFrontOrigin,
    });
    new CfnOutput(this, "AttachmentsBucket", { value: storage.attachments.bucketName });
    if (custom && api.domainName) {
      new CfnOutput(this, "AppDnsTarget", {
        value: web.distribution.distributionDomainName,
        description: `CNAME ${custom.appDomain} → this value`,
      });
      new CfnOutput(this, "WsDnsTarget", {
        value: api.domainName.regionalDomainName,
        description: `CNAME ${custom.wsDomain} → this value`,
      });
    }
  }
}
