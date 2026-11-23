import type Anthropic from "@anthropic-ai/sdk";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  canEditSales,
  canUseSales,
  CRM_FIELDS,
  duplicateOf,
  isDemoId,
  leadsSales,
  projectSignals,
  SalesAiSchema,
  SalesCrmApplySchema,
  salesDiff,
  SalesImportSchema,
  salesLabel,
  SalesRecordSchema,
  visibleSales,
  type SalesAccount,
  type SalesArtifact,
  type SalesChange,
  type SalesProject,
  type SalesRecord,
  type SalesResult,
  type SalesState,
} from "@mindfultech/shared";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { bedrockModel, type ClaudeModel } from "../lib/claude";
import { ddb, tables } from "../lib/ddb";
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
import { errorFields, log } from "../lib/logger";
import {
  contextFor,
  quotesResult,
  SALES_TIMEOUT_MS,
  salesRequest,
  salesResultFrom,
} from "../lib/salesAi";
import {
  APPLIED,
  artifactKey,
  changeItem,
  deleteKeys,
  loadSales,
  ORG,
  putArtifact,
  putRows,
  recordItem,
  recordKey,
  resetDemo,
  loadProjects,
  salesDirectory,
  salesPeople,
  type SalesRows,
} from "../lib/salesStore";
import { displayNameOf } from "../lib/users";

// ---------------------------------------------------------------------------
// Ventas (Phase 73): the sales assistant's API. For the team only. Every
// route starts from what the caller may see (`visibleSales`): lists, the
// model's context, quotes, exports (made by the page from these lists) and
// proposed changes all come out of that same set.
// ---------------------------------------------------------------------------

let model: ClaudeModel | null = null;
/** Tests: a fake model. */
export function useSalesModel(fake: ClaudeModel | null): void {
  model = fake;
}

interface Seen extends SalesRows {
  visible: SalesRecord[];
}

async function seenBy(caller: HttpCaller): Promise<Seen> {
  if (!canUseSales(caller.role)) throw forbidden("Ventas es para el equipo de MindfulTech");
  const rows = await loadSales();
  return { ...rows, visible: visibleSales(rows.records, caller.userId, caller.role) };
}

function stateFor(
  seen: Seen,
  caller: HttpCaller,
  people: SalesState["people"],
  projects: SalesProject[] = [],
): SalesState {
  const ids = new Set(seen.visible.map((r) => r.id));
  const mine = (ref: string) => !ref || ids.has(ref);
  return {
    records: seen.visible,
    // A result is shown to who made it, or with the records it's about.
    artifacts: seen.artifacts.filter(
      (a) =>
        a.demo ||
        a.ownerId === caller.userId ||
        (leadsSales(caller.role) && mine(a.accountId)) ||
        (!!a.accountId && ids.has(a.accountId) && mine(a.opportunityId) && mine(a.meetingId)),
    ),
    changes: seen.changes.filter((c) => ids.has(c.recordId)),
    people,
    projects,
  };
}

async function getState(_event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  return json(200, await fullState(caller));
}

/** Everything the page shows: the caller's records, the team, and their project channels. */
async function fullState(caller: HttpCaller): Promise<SalesState> {
  const [seen, dir] = await Promise.all([seenBy(caller), salesDirectory()]);
  let projects: SalesProject[] = [];
  try {
    projects = await loadProjects(caller, dir);
  } catch (err) {
    // The projects are an extra: Ventas still opens without them.
    log.error("sales projects not read", errorFields(err));
  }
  return stateFor(seen, caller, dir.people, projects);
}

const changesOf = (
  before: SalesRecord | null,
  after: SalesRecord,
  caller: HttpCaller,
  byName: string,
  at: number,
): SalesChange[] =>
  salesDiff(before, after).map((d) => ({
    id: ulid(at),
    recordKind: after.kind,
    recordId: after.id,
    accountId: after.kind === "account" ? after.id : "accountId" in after ? after.accountId : "",
    label: salesLabel(after),
    ...d,
    by: caller.userId,
    byName,
    at,
    ...(after.demo && { demo: true as const }),
  }));

/** `PUT /sales/records/{id}`: a record created or changed; each field that changes is logged. */
async function putRecord(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const seen = await seenBy(caller);
  const id = pathParam(event, "id");
  const input = parseBody(SalesRecordSchema, event);
  if (input.id !== id) throw new HttpError(400, "El id no coincide");
  const existing = seen.records.find((r) => r.id === id) ?? null;
  if (existing) {
    if (existing.kind !== input.kind)
      throw new HttpError(400, "No se cambia el tipo de un registro");
    if (
      !seen.visible.includes(existing) ||
      !canEditSales(existing, seen.visible, caller.userId, caller.role)
    ) {
      throw notFound("Registro no encontrado");
    }
  } else if (isDemoId(id)) {
    throw new HttpError(400, "Ese id está reservado para la demo");
  }
  // What it hangs from must be the caller's to see.
  for (const ref of ["accountId", "opportunityId"] as const) {
    const value = (input as Record<string, unknown>)[ref];
    if (typeof value === "string" && value && !seen.visible.some((r) => r.id === value)) {
      throw new HttpError(400, "La cuenta u oportunidad no existe");
    }
  }
  if (
    input.kind === "account" &&
    input.channelId &&
    input.channelId !== (existing as { channelId?: string } | null)?.channelId
  ) {
    const projects = await loadProjects(caller, await salesDirectory());
    if (!projects.some((p) => p.channelId === input.channelId)) {
      throw new HttpError(400, "Ese proyecto no existe o no lo ves");
    }
  }
  const now = Date.now();
  const people = await salesPeople();
  const nameOf = (userId: string) => people.find((p) => p.userId === userId)?.name;
  // Only an admin hands a record to someone else; otherwise it stays whose it was.
  const ownerId =
    leadsSales(caller.role) &&
    input.ownerId &&
    (nameOf(input.ownerId) || existing?.ownerId === input.ownerId)
      ? input.ownerId
      : (existing?.ownerId ?? caller.userId);
  const byName = nameOf(caller.userId) ?? (await displayNameOf(caller));
  const record: SalesRecord = {
    ...input,
    ownerId,
    ownerName: ownerId === existing?.ownerId ? existing.ownerName : (nameOf(ownerId) ?? byName),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.demo && { demo: true as const }),
  };
  const changes = changesOf(existing, record, caller, byName, now);
  await putRows([recordItem(record), ...changes.map(changeItem)]);
  log.info("sales record saved", {
    id,
    kind: record.kind,
    userId: caller.userId,
    changes: changes.length,
  });
  return json(200, { record, changes });
}

/** `DELETE /sales/records/{id}`: the record; an account takes what hangs from it. */
async function deleteRecord(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const seen = await seenBy(caller);
  const id = pathParam(event, "id");
  const record = seen.visible.find((r) => r.id === id);
  if (!record || !canEditSales(record, seen.visible, caller.userId, caller.role)) {
    throw notFound("Registro no encontrado");
  }
  const gone = [
    record,
    ...(record.kind === "account"
      ? seen.records.filter((r) => "accountId" in r && r.accountId === id)
      : []),
  ];
  const ids = new Set(gone.map((r) => r.id));
  await deleteKeys([
    ...gone.map((r) => recordKey(r.id)),
    ...seen.artifacts
      .filter((a) => ids.has(a.accountId) || ids.has(a.opportunityId) || ids.has(a.meetingId))
      .map((a) => artifactKey(a.id)),
  ]);
  log.info("sales record deleted", {
    id,
    kind: record.kind,
    userId: caller.userId,
    rows: gone.length,
  });
  return json(200, { deleted: [...ids] });
}

/** The hours of the client's project channel, computed, for the model to use as given. */
async function projectFacts(caller: HttpCaller, context: SalesRecord[]): Promise<string> {
  const linked = context.filter((r): r is SalesAccount => r.kind === "account" && !!r.channelId);
  if (linked.length === 0) return "";
  try {
    const projects = await loadProjects(caller, await salesDirectory());
    return linked
      .map((a) => {
        const p = projects.find((x) => x.channelId === a.channelId);
        if (!p) return "";
        const signals = projectSignals(p).map((x) => x.text);
        return (
          `Proyecto en curso con ${a.name} (registro ${a.id}, canal #${p.name}), calculado de las horas registradas: ` +
          `${p.hours30} h en los últimos 30 días (${p.hoursPrev30} h en los 30 anteriores), ${p.hoursTotal} h en total, ` +
          `${p.people} personas, último registro ${p.lastEntry || "ninguno"}` +
          (p.billedTotal !== undefined
            ? `, facturable USD ${p.billed30} en 30 días y USD ${p.billedTotal} en total`
            : "") +
          (signals.length ? `. Señales: ${signals.join("; ")}` : "") +
          "."
        );
      })
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

const artifactId = (flow: string, parts: string[]) =>
  `art_${flow}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 20)}`;

/**
 * `POST /sales/ai`: one of the assistant's flows over the caller's records.
 * The result replaces the earlier one for the same flow and records (a retry
 * leaves one, not two).
 */
async function runFlow(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const seen = await seenBy(caller);
  const ask = parseBody(SalesAiSchema, event);
  for (const ref of [ask.accountId, ask.opportunityId, ask.meetingId]) {
    if (ref && !seen.visible.some((r) => r.id === ref)) throw notFound("Registro no encontrado");
  }
  if (ask.flow === "coaching" || ask.flow === "trends") {
    ask.repId ||= caller.userId;
    // Someone else's coaching: their lead, or the demo's rep.
    const theirs = seen.visible.filter((r) => r.kind === "call" && r.ownerId === ask.repId);
    if (ask.repId !== caller.userId && !leadsSales(caller.role) && !theirs.every((c) => c.demo)) {
      throw forbidden("Solo ves tu propio coaching");
    }
    if (theirs.length === 0) throw new HttpError(400, "Ese vendedor no tiene llamadas registradas");
  }
  const now = Date.now();
  const context = contextFor(ask, seen.visible, now);
  const started = now;
  let result: SalesResult | null = null;
  let response: Anthropic.Message | null = null;
  try {
    response = await (model ??= bedrockModel(SALES_TIMEOUT_MS, 0)).create(
      salesRequest(ask, context, seen.changes, now, await projectFacts(caller, context)),
    );
    result = salesResultFrom(response, context, ask.input);
  } catch (err) {
    log.error("sales flow failed", {
      flow: ask.flow,
      ms: Date.now() - started,
      ...errorFields(err),
    });
  }
  // Quotes don't depend on the model: the exact fragments the code finds are always there.
  if (ask.flow === "quotes") {
    const exact = quotesResult(context, ask.input);
    if (!result || result.sections.length === 0) result = exact;
    else {
      const known = new Set(result.sections.flatMap((s) => s.items.map((i) => i.quote)));
      const more = (exact.sections[0]?.items ?? []).filter((i) => !known.has(i.quote));
      if (more.length) result.sections.push({ heading: "Más fragmentos exactos", items: more });
    }
  }
  if (!result) throw new HttpError(502, "El asistente no pudo responder ahora. Intenta de nuevo.");
  const byName = await displayNameOf(caller);
  const account =
    ask.accountId ||
    (() => {
      const r = seen.visible.find((x) => x.id === (ask.opportunityId || ask.meetingId));
      return r && "accountId" in r ? r.accountId : "";
    })();
  const refs = [ask.accountId, ask.opportunityId, ask.meetingId, ask.repId];
  const scoped = refs.some(Boolean);
  const artifact: SalesArtifact = {
    // About records: one per flow and records. Free-form (a question, a list): one per person and flow.
    id: artifactId(ask.flow, scoped ? refs : [caller.userId]),
    kind: "artifact",
    flow: ask.flow,
    accountId: account,
    opportunityId: ask.opportunityId,
    meetingId: ask.meetingId,
    ...(ask.repId && { repId: ask.repId }),
    ownerId: caller.userId,
    ownerName: byName,
    result,
    createdAt: now,
    updatedAt: now,
    ...(context.length > 0 && context.every((r) => r.demo) && scoped && { demo: true as const }),
  };
  await putArtifact(artifact);
  log.info("sales flow answered", {
    flow: ask.flow,
    userId: caller.userId,
    records: context.length,
    inputTokens: response?.usage.input_tokens ?? 0,
    ms: Date.now() - started,
  });
  return json(200, { artifact });
}

/**
 * `POST /sales/crm/apply`: the changes the rep reviewed and confirmed. Once:
 * the same `key` again answers with what was applied the first time.
 */
async function applyCrm(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const seen = await seenBy(caller);
  const { key, updates } = parseBody(SalesCrmApplySchema, event);
  const marker = { pk: ORG, sk: `${APPLIED}${key}` };
  const earlier = await ddb.send(new GetCommand({ TableName: tables.sales, Key: marker }));
  if (earlier.Item) {
    if (earlier.Item.by !== caller.userId)
      throw new HttpError(409, "Esa operación es de otra persona");
    return json(200, { applied: earlier.Item.applied, repeated: true });
  }
  const now = Date.now();
  const byName = await displayNameOf(caller);
  const next = new Map<string, SalesRecord>();
  const changes: SalesChange[] = [];
  for (const u of updates) {
    const current = next.get(u.recordId) ?? seen.visible.find((r) => r.id === u.recordId);
    if (
      !current ||
      (current.kind !== "opportunity" && current.kind !== "account") ||
      !canEditSales(current, seen.visible, caller.userId, caller.role)
    ) {
      throw notFound("Registro no encontrado");
    }
    if (!CRM_FIELDS[current.kind].includes(u.field)) {
      throw new HttpError(400, `El campo ${u.field} no se actualiza desde aquí`);
    }
    const value = u.field === "amount" ? Number(u.value.replace(/[^\d.]/g, "")) : u.value;
    const parsed = SalesRecordSchema.safeParse({ ...current, [u.field]: value });
    if (!parsed.success) throw new HttpError(400, `Valor no válido para ${u.field}: ${u.value}`);
    const record: SalesRecord = {
      ...parsed.data,
      createdAt: current.createdAt,
      updatedAt: now,
      ...(current.demo && { demo: true as const }),
    };
    changes.push(...changesOf(current, record, caller, byName, now));
    next.set(record.id, record);
  }
  const applied = changes.map(({ recordId, field, from, to }) => ({ recordId, field, from, to }));
  try {
    // First the marker (only one request gets it), then the rows.
    await ddb.send(
      new PutCommand({
        TableName: tables.sales,
        Item: { ...marker, by: caller.userId, at: now, applied },
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return json(200, { applied, repeated: true });
    }
    throw err;
  }
  await putRows([...[...next.values()].map(recordItem), ...changes.map(changeItem)]);
  log.info("sales crm update applied", { userId: caller.userId, changes: changes.length });
  return json(200, { applied, repeated: false, records: [...next.values()] });
}

/** `POST /sales/import`: prospecting results as accounts (and contacts); a company already there isn't added twice. */
async function importLeads(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const seen = await seenBy(caller);
  const { leads } = parseBody(SalesImportSchema, event);
  const now = Date.now();
  const byName = await displayNameOf(caller);
  // Against every account of the organization, so a colleague's isn't duplicated either.
  const accounts = seen.records.filter((r): r is SalesAccount => r.kind === "account");
  const rows: SalesRecord[] = [];
  const skipped: Array<{ company: string; accountId: string }> = [];
  const stamp = { ownerId: caller.userId, ownerName: byName, createdAt: now, updatedAt: now };
  const sourceDate = new Date(now).toISOString().slice(0, 10);
  for (const lead of leads) {
    let accountId = duplicateOf(lead, accounts);
    if (accountId) {
      skipped.push({ company: lead.company, accountId });
      // A new contact still goes to an account the caller may add to.
      if (!seen.visible.some((r) => r.id === accountId)) continue;
    } else {
      accountId = `acct_${ulid(now).toLowerCase()}`;
      const account = SalesRecordSchema.parse({
        id: accountId,
        kind: "account",
        name: lead.company,
        domain: lead.domain,
        industry: lead.industry,
        country: lead.country,
        size: lead.size,
        source: lead.source,
        sourceDate,
      }) as SalesAccount;
      const row = { ...account, ...stamp };
      rows.push(row);
      accounts.push(row);
    }
    if (lead.contactName || lead.contactTitle) {
      const known = [...seen.records, ...rows].some(
        (r) =>
          r.kind === "contact" &&
          r.accountId === accountId &&
          r.name.toLowerCase() === lead.contactName.toLowerCase() &&
          r.title.toLowerCase() === lead.contactTitle.toLowerCase(),
      );
      if (!known) {
        rows.push({
          ...SalesRecordSchema.parse({
            id: `ct_${ulid(now + rows.length).toLowerCase()}`,
            kind: "contact",
            accountId,
            name: lead.contactName,
            title: lead.contactTitle,
            email: lead.email,
            source: lead.source,
            sourceDate,
          }),
          ...stamp,
        });
      }
    }
  }
  const changes = rows.flatMap((r) => changesOf(null, r, caller, byName, now));
  await putRows([...rows.map(recordItem), ...changes.map(changeItem)]);
  log.info("sales leads imported", {
    userId: caller.userId,
    added: rows.length,
    skipped: skipped.length,
  });
  return json(200, { added: rows, skipped });
}

/**
 * `POST /sales/demo/reset`: the demo's fictitious rows back to how they start;
 * with `{ "clear": true }`, taken away (real records are never touched).
 */
async function demoReset(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  if (!canUseSales(caller.role)) throw forbidden("Ventas es para el equipo de MindfulTech");
  let clear = false;
  try {
    clear = (JSON.parse(event.body || "{}") as { clear?: unknown }).clear === true;
  } catch {
    // No body, or not JSON: a plain reset.
  }
  await resetDemo(await loadSales(), Date.now(), !clear);
  log.info(clear ? "sales demo cleared" : "sales demo reset", { userId: caller.userId });
  return json(200, await fullState(caller));
}

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "GET /sales": getState,
  "PUT /sales/records/{id}": putRecord,
  "DELETE /sales/records/{id}": deleteRecord,
  "POST /sales/ai": runFlow,
  "POST /sales/crm/apply": applyCrm,
  "POST /sales/import": importLeads,
  "POST /sales/demo/reset": demoReset,
};

export const handler = httpHandler(async (event, caller) => {
  const route = ROUTES[event.routeKey];
  if (!route) throw notFound(`No route for ${event.routeKey}`);
  return route(event, caller);
});
