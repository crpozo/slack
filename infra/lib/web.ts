import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Annotations, Duration } from "aws-cdk-lib";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, CacheControl, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { removalPolicyFor, type Stage } from "./stage";

const WEB_DIST = fileURLToPath(new URL("../../apps/web/dist", import.meta.url));

export class Web extends Construct {
  readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: { stage: Stage; bucket: Bucket }) {
    super(scope, id);

    this.distribution = new Distribution(this, "Distribution", {
      comment: `slack-${props.stage}`,
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(props.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        // Honours the Cache-Control headers set on each object below.
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      // SPA routing: unknown paths are served by index.html.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: "/index.html",
        ttl: Duration.seconds(0),
      })),
    });

    if (!existsSync(WEB_DIST)) {
      Annotations.of(this).addWarning(
        `${WEB_DIST} not found; skipping SPA upload. Run \`pnpm --filter web build\` first.`,
      );
      return;
    }

    // One log group shared by both deployments (they share the same singleton Lambda).
    const logGroup = new LogGroup(this, "DeploymentLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: removalPolicyFor(props.stage),
    });

    // Hashed assets first (immutable, 1 year), then index.html (no-cache) + invalidation.
    const assets = new BucketDeployment(this, "DeployAssets", {
      destinationBucket: props.bucket,
      sources: [Source.asset(WEB_DIST, { exclude: ["index.html"] })],
      cacheControl: [
        CacheControl.setPublic(),
        CacheControl.maxAge(Duration.days(365)),
        CacheControl.immutable(),
      ],
      prune: false,
      logGroup,
    });

    const index = new BucketDeployment(this, "DeployIndex", {
      destinationBucket: props.bucket,
      sources: [Source.asset(WEB_DIST, { exclude: ["*", "!index.html"] })],
      cacheControl: [CacheControl.noCache()],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      logGroup,
    });
    index.node.addDependency(assets);
  }
}
