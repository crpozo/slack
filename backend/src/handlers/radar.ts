import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateBlipSchema, UpdateBlipSchema, type RadarSnapshot } from "@mindfultech/shared";
import { requireEnv } from "../lib/env";
import {
  forbidden,
  HttpError,
  httpHandler,
  json,
  notFound,
  parseBody,
  pathParam,
  type HttpCaller,
  type HttpEvent,
  type HttpResult,
} from "../lib/http";
import { log } from "../lib/logger";
import {
  DISCOVERY_SCAN_ID,
  deleteBlip,
  getBlip,
  getProposal,
  lastScanAt,
  listBlips,
  listProposals,
  moveBlip,
  newBlip,
  putBlipIfAbsent,
  resolveProposal,
  updateBlip,
} from "../lib/radar";

let lambda: LambdaClient | null = null;
const lambdaClient = () => (lambda ??= new LambdaClient({}));

/** Everyone on the team reads the radar; guests (external clients) don't see it at all. */
function teamOnly(caller: HttpCaller): void {
  if (caller.role === "guest") throw forbidden("The radar is for the team");
}

/** Blips and proposals change only through admins (the scanner is the other author). */
function adminOnly(caller: HttpCaller, what: string): void {
  teamOnly(caller);
  if (caller.role !== "admin") throw forbidden(`Only an admin can ${what}`);
}

async function snapshot(): Promise<RadarSnapshot> {
  const [blips, proposals, scannedAt, discoveredAt] = await Promise.all([
    listBlips(),
    listProposals("pending"),
    lastScanAt(),
    lastScanAt(DISCOVERY_SCAN_ID),
  ]);
  return { blips, proposals, lastScanAt: scannedAt, lastDiscoveryAt: discoveredAt };
}

async function createBlip(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  adminOnly(caller, "add a technology");
  const input = parseBody(CreateBlipSchema, event);
  const blip = newBlip(input, caller.userId);
  if (!(await putBlipIfAbsent(blip))) {
    throw new HttpError(409, `“${input.name}” is already on the radar`);
  }
  log.info("radar blip added", { id: blip.id, ring: blip.ring, userId: caller.userId });
  return json(201, { blip });
}

async function editBlip(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  adminOnly(caller, "change the radar");
  const id = pathParam(event, "id");
  const patch = parseBody(UpdateBlipSchema, event);
  const blip = await updateBlip(id, patch, caller.userId);
  if (!blip) throw notFound("No such technology on the radar");
  log.info("radar blip updated", { id, fields: Object.keys(patch), userId: caller.userId });
  return json(200, { blip });
}

async function removeBlip(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  adminOnly(caller, "remove a technology");
  const id = pathParam(event, "id");
  if (!(await getBlip(id))) throw notFound("No such technology on the radar");
  await deleteBlip(id);
  log.info("radar blip removed", { id, userId: caller.userId });
  return json(200, { deleted: id });
}

/**
 * `apply` (the panel's Accept): a move happens, an add is created in its ring
 * (Assess); `dismiss` (Reject): it leaves the panel. The rejected row is kept
 * a month (then pruned) so the scans don't propose the same technology again.
 */
async function decideProposal(
  event: HttpEvent,
  caller: HttpCaller,
  decision: "applied" | "dismissed",
): Promise<HttpResult> {
  adminOnly(caller, "decide on a proposal");
  const id = pathParam(event, "id");
  const proposal = await getProposal(id);
  if (!proposal || proposal.status !== "pending") throw notFound("That proposal is gone");
  let blip = null;
  if (decision === "applied") {
    if (proposal.kind === "move" && proposal.blipId) {
      blip = await moveBlip(proposal.blipId, proposal.ring, caller.userId);
      if (!blip) throw notFound("The technology this proposal is about was removed");
    } else {
      blip = newBlip(
        {
          name: proposal.name,
          quadrant: proposal.quadrant,
          ring: proposal.ring,
          description: proposal.description ?? "",
          ...(proposal.sourceLink && { link: proposal.sourceLink }),
          ...(proposal.meta && { meta: proposal.meta }),
        },
        caller.userId,
      );
      if (!(await putBlipIfAbsent(blip))) blip = await getBlip(blip.id);
    }
  }
  const resolved = await resolveProposal(id, decision, caller.userId);
  if (!resolved) throw notFound("That proposal is gone");
  log.info("radar proposal decided", { id, decision, userId: caller.userId });
  return json(200, { proposal: resolved, blip });
}

/**
 * `POST /radar/scan`: an admin asks for a scan now. Both scanners run in the
 * background: the news scan (moves) and the Discovery Engine (new technologies).
 */
async function scanNow(caller: HttpCaller): Promise<HttpResult> {
  adminOnly(caller, "start a scan");
  await Promise.all(
    [requireEnv("RADAR_WORKER_FUNCTION"), requireEnv("RADAR_DISCOVERY_FUNCTION")].map(
      (FunctionName) =>
        lambdaClient().send(new InvokeCommand({ FunctionName, InvocationType: "Event" })),
    ),
  );
  log.info("radar scan requested", { userId: caller.userId });
  return json(202, { started: true });
}

/**
 * AI Tech Radar (Phase 56), on the HTTP API behind the Cognito JWT authorizer:
 *   GET    /radar                         → `{ blips, proposals, lastScanAt, lastDiscoveryAt }`
 *   POST   /radar/blips                   (admin) → 201 `{ blip }`
 *   PUT    /radar/blips/{id}              (admin) → `{ blip }` (a new ring records the move)
 *   DELETE /radar/blips/{id}              (admin)
 *   POST   /radar/proposals/{id}/apply    (admin) → `{ proposal, blip }`
 *   POST   /radar/proposals/{id}/dismiss  (admin) → `{ proposal }`
 *   POST   /radar/scan                    (admin) → 202 (both scanners run asynchronously)
 */
export const handler = httpHandler(async (event, caller) => {
  switch (event.routeKey) {
    case "GET /radar":
      teamOnly(caller);
      return json(200, await snapshot());
    case "POST /radar/blips":
      return createBlip(event, caller);
    case "PUT /radar/blips/{id}":
      return editBlip(event, caller);
    case "DELETE /radar/blips/{id}":
      return removeBlip(event, caller);
    case "POST /radar/proposals/{id}/apply":
      return decideProposal(event, caller, "applied");
    case "POST /radar/proposals/{id}/dismiss":
      return decideProposal(event, caller, "dismissed");
    case "POST /radar/scan":
      return scanNow(caller);
    default:
      throw notFound(`No route for ${event.routeKey}`);
  }
});
