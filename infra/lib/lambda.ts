import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { OutputFormat, type BundlingOptions } from "aws-cdk-lib/aws-lambda-nodejs";

/**
 * What every Lambda of the project shares: the runtime, the memory and how
 * its handler is bundled. Both APIs (`api.ts`, `tasks-api.ts`) build their
 * functions from this, so a tuning applies to all of them at once.
 */

export const LAMBDA_RUNTIME = Runtime.NODEJS_22_X;
export const LAMBDA_ARCHITECTURE = Architecture.ARM_64;

/**
 * 512 MB. Lambda gives CPU in proportion to memory, and these handlers are
 * short (a few DynamoDB calls, a signature or two): most of a cold start is
 * parsing the bundle, and most of a warm invocation is the SDK's own work, so
 * at 256 MB they waited on CPU, not on I/O. Doubling the memory halves both
 * (a cold start drops from ~0.6 s to ~0.3 s) while the per-invocation cost
 * barely moves: a 100 ms invocation costs $0.0000008 either way, within
 * rounding at this team's volume, and well inside the free tier.
 */
export const LAMBDA_MEMORY_MB = 512;

/**
 * One bundle per handler, as ES modules. Compared to the CommonJS output
 * esbuild makes by default, the AWS SDK's ESM entry points tree-shake: each
 * bundle drops 25–30 % (e.g. `message` 1.75 → 1.26 MB, `ping` 1.14 → 0.84 MB),
 * which is that much less to download and parse on every cold start. The
 * SDK is bundled too: the versions we test are the versions we ship.
 *
 * The banner gives CommonJS dependencies inside the bundle a `require`
 * (there is none in an ES module), the standard esbuild recipe for ESM
 * output; `mainFields` prefers packages' ESM builds so they tree-shake.
 */
export const LAMBDA_BUNDLING: BundlingOptions = {
  format: OutputFormat.ESM,
  mainFields: ["module", "main"],
  banner:
    "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  minify: true,
  sourceMap: false,
  target: "node22",
  externalModules: [],
};
