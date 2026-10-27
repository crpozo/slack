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

/** Below this, Glacier Instant Retrieval bills an object as if it were this big. */
export const GLACIER_IR_MIN_BILLABLE_BYTES = 128 * 1024;

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
          // Files nobody has opened in three months move to a class that costs
          // a sixth to store and still downloads at once. Only files above
          // Glacier Instant Retrieval's minimum billable size (128 KB) go:
          // below it every object is billed as 128 KB, which for thumbnails and
          // small files costs more than Standard did, plus a transition
          // request each.
          id: "ColdAfter90Days",
          objectSizeGreaterThan: GLACIER_IR_MIN_BILLABLE_BYTES,
          transitions: [
            {
              storageClass: StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: Duration.days(90),
            },
          ],
        },
        {
          // Uploads are single presigned PUTs today; should a client ever start
          // a multipart upload and abandon it, its parts are billed until removed.
          id: "AbortStaleMultipartUploads",
          abortIncompleteMultipartUploadAfter: Duration.days(7),
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
      // Presigned PUTs send Content-Type and Cache-Control; signed headers must be allowed.
      allowedHeaders: ["content-type", "content-length", "cache-control"],
      maxAge: 3000,
    });
  }
}
