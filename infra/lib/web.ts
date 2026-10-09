import { execFileSync } from "node:child_process";
import { cpSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetHashType, DockerImage, Duration } from "aws-cdk-lib";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import {
  BucketDeployment,
  CacheControl,
  Source,
  type ISource,
} from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { removalPolicyFor, type Stage } from "./stage";

const WEB_DIR = fileURLToPath(new URL("../../apps/web", import.meta.url));

/**
 * Absolute path of the Vite CLI installed for apps/web. Running it with the
 * current Node binary (`process.execPath`) avoids resolving any executable
 * through `PATH`.
 */
function viteCli(): string {
  const pkgPath = createRequire(join(WEB_DIR, "package.json")).resolve("vite/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: { vite: string } };
  return join(dirname(pkgPath), pkg.bin.vite);
}

/** Values the SPA reads from `/config.json` at startup (see apps/web/src/lib/config.ts). */
export interface WebRuntimeConfig {
  wsUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  /** Optional team directory for DMs, `email=sub,email=sub`. */
  users?: string;
}

interface WebProps {
  stage: Stage;
  bucket: Bucket;
  runtimeConfig: WebRuntimeConfig;
  /** Skip `vite build` (e.g. for `cdk destroy`); uploads a placeholder page instead. */
  skipBuild?: boolean;
  /** e.g. `slack.mindfultech.ec`; the certificate must live in us-east-1. */
  customDomain?: { domainName: string; certificate: ICertificate };
}

let builtDir: string | undefined;

/**
 * Builds `apps/web` during synth: `vite build` writes straight into the asset
 * staging directory, so `cdk deploy` alone produces and uploads a fresh bundle.
 */
function webBuildSource(skipBuild: boolean): ISource {
  if (skipBuild) {
    return Source.data("index.html", "<!doctype html><title>MindfulTech Slack</title>");
  }
  return Source.asset(WEB_DIR, {
    // Always rebuild: the bundle also depends on packages/shared, outside WEB_DIR.
    assetHashType: AssetHashType.OUTPUT,
    exclude: ["node_modules", "dist"],
    bundling: {
      // Required by the API but unused: local bundling always succeeds or throws.
      image: DockerImage.fromRegistry("public.ecr.aws/docker/library/node:22"),
      local: {
        tryBundle(outputDir) {
          // Both stacks synthesize in one `cdk` run: build once, copy for the other.
          if (builtDir) {
            cpSync(builtDir, outputDir, { recursive: true });
          } else {
            execFileSync(
              process.execPath,
              [viteCli(), "build", "--outDir", outputDir, "--emptyOutDir"],
              { cwd: WEB_DIR, stdio: "inherit" },
            );
            builtDir = outputDir;
          }
          return true;
        },
      },
    },
  });
}

export class Web extends Construct {
  readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: WebProps) {
    super(scope, id);

    this.distribution = new Distribution(this, "Distribution", {
      comment: `slack-${props.stage}`,
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultRootObject: "index.html",
      ...(props.customDomain && {
        domainNames: [props.customDomain.domainName],
        certificate: props.customDomain.certificate,
      }),
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(props.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        // Honours the Cache-Control headers set on each object below.
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        // HSTS, nosniff, frame denial, referrer policy.
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
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

    // One log group shared by both deployments (they share the same singleton Lambda).
    const logGroup = new LogGroup(this, "DeploymentLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: removalPolicyFor(props.stage),
    });

    const build = webBuildSource(props.skipBuild ?? false);
    // Resolved at deploy time from this stack's own resources: no rebuild needed
    // when the API or user pool ids change, and no chicken-and-egg on first deploy.
    const runtimeConfig = Source.jsonData("config.json", props.runtimeConfig);

    // Hashed assets first (immutable, 1 year)…
    const assets = new BucketDeployment(this, "DeployAssets", {
      destinationBucket: props.bucket,
      sources: [build],
      exclude: ["index.html", "config.json"],
      cacheControl: [
        CacheControl.setPublic(),
        CacheControl.maxAge(Duration.days(365)),
        CacheControl.immutable(),
      ],
      prune: false,
      logGroup,
    });

    // …then the entry points (never cached) and a CloudFront invalidation.
    const entry = new BucketDeployment(this, "DeployIndex", {
      destinationBucket: props.bucket,
      sources: [build, runtimeConfig],
      exclude: ["*"],
      include: ["index.html", "config.json"],
      cacheControl: [CacheControl.noCache()],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      logGroup,
    });
    entry.node.addDependency(assets);
  }
}
