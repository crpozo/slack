import { Duration } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  StorageClass,
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { removalPolicyFor, type Stage } from "./stage";

export class Storage extends Construct {
  readonly attachments: Bucket;
  readonly web: Bucket;

  constructor(scope: Construct, id: string, props: { stage: Stage }) {
    super(scope, id);
    const common = {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: removalPolicyFor(props.stage),
      autoDeleteObjects: props.stage === "dev",
    };

    this.attachments = new Bucket(this, "Attachments", {
      ...common,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: Duration.days(90),
            },
          ],
        },
      ],
    });

    this.web = new Bucket(this, "Web", common);
  }

  /** Lets these browser origins PUT/GET attachments through presigned URLs. */
  allowBrowserOrigins(origins: string[]): void {
    this.attachments.addCorsRule({
      allowedMethods: [HttpMethods.PUT, HttpMethods.GET],
      allowedOrigins: origins,
      // Presigned PUTs send Content-Type; signed headers must be allowed.
      allowedHeaders: ["content-type", "content-length"],
      maxAge: 3000,
    });
  }
}
