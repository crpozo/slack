import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  PLATFORM_INSIGHTS_WAIT_MS,
  type PlatformInsightsAccess,
  type PlatformInsightsResponse,
  type PlatformInsightsStarted,
  type PlatformReport,
} from "@mindfultech/shared";
import { bedrockModel, type StreamingClaudeModel } from "../lib/claude";
import { requireEnv } from "../lib/env";
import {
  forbidden,
  httpHandler,
  json,
  notFound,
  type HttpEvent,
  type HttpResult,
} from "../lib/http";
import { errorFields, log } from "../lib/logger";
import {
  analysisFrom,
  analysisRequest,
  claimReport,
  collectMetrics,
  isInsightsOwner,
  latestReport,
  reportState,
  saveReport,
  settleReport,
} from "../lib/platformInsights";

/**
 * Platform Insights (Phase 64). Only the owners named in the deployment's
 * configuration get anything but `access`: not a role, so an admin doesn't.
 *
 * `GET /platform-insights/access`: whether the caller sees the section.
 * `GET /platform-insights`: the latest report, and whether one is being written.
 * `POST /platform-insights`: writes a new one. Reading the tables and asking
 * the model takes longer than an HTTP request may, so this function invokes
 * itself asynchronously (`{ generate }`) and the page polls the GET.
 */
const MODEL_TIMEOUT_MS = 90_000;
let model: StreamingClaudeModel | null = null;
/** Tests: a fake model. */
export function usePlatformInsightsModel(fake: StreamingClaudeModel | null): void {
  model = fake;
}
let lambda: LambdaClient | null = null;

interface GenerateEvent {
  generate: { requestedAt: number };
}

const http = httpHandler(async (event, caller): Promise<HttpResult> => {
  const allowed = await isInsightsOwner(caller.email);
  if (event.routeKey === "GET /platform-insights/access") {
    const body: PlatformInsightsAccess = { allowed };
    return json(200, body);
  }
  if (!allowed) throw forbidden("This section isn't available for your account");
  switch (event.routeKey) {
    case "GET /platform-insights": {
      const [report, state] = await Promise.all([latestReport(), reportState()]);
      const running =
        state && !state.done && Date.now() - state.requestedAt < PLATFORM_INSIGHTS_WAIT_MS;
      const body: PlatformInsightsResponse = {
        report,
        ...(running && { generatingSince: state.requestedAt }),
        ...(state?.done && state.error && { error: state.error }),
      };
      return json(200, body);
    }
    case "POST /platform-insights": {
      const now = Date.now();
      const claim = await claimReport(now);
      let body: PlatformInsightsStarted;
      if (claim.ok) {
        const payload: GenerateEvent = { generate: { requestedAt: now } };
        await (lambda ??= new LambdaClient({})).send(
          new InvokeCommand({
            FunctionName: requireEnv("AWS_LAMBDA_FUNCTION_NAME"),
            InvocationType: "Event",
            Payload: new TextEncoder().encode(JSON.stringify(payload)),
          }),
        );
        log.info("platform insights requested", { userId: caller.userId });
        body = { queued: true };
      } else {
        body = { queued: false, retryAfterSeconds: claim.retryAfterSeconds };
      }
      return json(202, body);
    }
    default:
      throw notFound(`No route for ${event.routeKey}`);
  }
});

/** The asynchronous run: the numbers, then the model's reading of them. */
export async function generate(requestedAt: number): Promise<void> {
  const started = Date.now();
  try {
    const metrics = await collectMetrics(started);
    const report: PlatformReport = { generatedAt: started, metrics };
    try {
      const response = await (model ??= bedrockModel(MODEL_TIMEOUT_MS, 0)).stream(
        analysisRequest(metrics),
      );
      const outcome = analysisFrom(response);
      if (outcome.ok) report.analysis = outcome.analysis;
      else report.analysisError = outcome.error;
    } catch (err) {
      // The numbers are worth showing even when the model can't be reached.
      log.warn("platform insights: model failed", errorFields(err));
      report.analysisError = "No se pudo escribir el análisis con IA. Los números sí están al día.";
    }
    await saveReport(report);
    await settleReport(requestedAt);
    log.info("platform insights written", {
      messages: metrics.messages.total,
      people: metrics.people.total,
      analysis: !!report.analysis,
      ms: Date.now() - started,
    });
  } catch (err) {
    log.error("platform insights failed", errorFields(err));
    await settleReport(requestedAt, "No se pudieron leer los datos de la plataforma.").catch(
      () => undefined,
    );
  }
}

export const handler = async (event: HttpEvent | GenerateEvent): Promise<HttpResult | void> => {
  if ("generate" in event) return generate(event.generate.requestedAt);
  return http(event);
};
