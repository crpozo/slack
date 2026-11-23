import { BatchWriteCommand, paginateQuery, paginateScan, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  canSeeChannel,
  projectSummary,
  type Channel,
  type Role,
  type SalesProject,
  demoSalesSeed,
  isDemoId,
  type SalesArtifact,
  type SalesChange,
  type SalesRecord,
} from "@mindfultech/shared";
import { ddb, tables } from "./ddb";

// ---------------------------------------------------------------------------
// Ventas (Phase 73): its rows. One partition per organization (this
// deployment has one, `ORG`), so one organization's data can never be read
// with another's key: `rec#<id>` a record, `art#<id>` a generated result,
// `chg#<time>#<id>` a field that changed, `applied#<key>` a confirmed CRM
// update (so a retry applies nothing twice).
// ---------------------------------------------------------------------------

export const ORG = "mindfultech";
const REC = "rec#";
const ART = "art#";
const CHG = "chg#";
export const APPLIED = "applied#";
/** How far back the change log is read. */
const CHANGE_DAYS = 120;

export interface SalesRows {
  records: SalesRecord[];
  artifacts: SalesArtifact[];
  changes: SalesChange[];
}

const strip = <T>(item: Record<string, unknown>): T => {
  const rest = { ...item };
  delete rest.pk;
  delete rest.sk;
  return rest as T;
};

/** Everything of the organization (the caller filters it to what a person may see). */
export async function loadSales(now = Date.now()): Promise<SalesRows> {
  const rows: SalesRows = { records: [], artifacts: [], changes: [] };
  const from = now - CHANGE_DAYS * 86_400_000;
  const pages = paginateQuery(
    { client: ddb },
    {
      TableName: tables.sales,
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": ORG },
    },
  );
  for await (const page of pages) {
    for (const item of page.Items ?? []) {
      const sk = String(item.sk);
      if (sk.startsWith(REC)) rows.records.push(strip(item));
      else if (sk.startsWith(ART)) rows.artifacts.push(strip(item));
      else if (sk.startsWith(CHG) && Number(item.at) >= from) rows.changes.push(strip(item));
    }
  }
  rows.changes.sort((a, b) => b.at - a.at);
  return rows;
}

export const recordKey = (id: string) => ({ pk: ORG, sk: `${REC}${id}` });
export const artifactKey = (id: string) => ({ pk: ORG, sk: `${ART}${id}` });
const changeKey = (c: SalesChange) => ({
  pk: ORG,
  sk: `${CHG}${String(c.at).padStart(15, "0")}#${c.id}`,
});

export const recordItem = (r: SalesRecord) => ({ ...r, ...recordKey(r.id) });
export const artifactItem = (a: SalesArtifact) => ({ ...a, ...artifactKey(a.id) });
export const changeItem = (c: SalesChange) => ({ ...c, ...changeKey(c) });

export async function putRows(items: Array<Record<string, unknown>>): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let pending: Array<{ PutRequest: { Item: Record<string, unknown> } }> = items
      .slice(i, i + 25)
      .map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length && attempt < 5; attempt++) {
      const out = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [tables.sales]: pending } }),
      );
      pending = (out.UnprocessedItems?.[tables.sales] ?? []) as typeof pending;
    }
    if (pending.length) throw new Error("sales rows not written");
  }
}

export async function deleteKeys(keys: Array<{ pk: string; sk: string }>): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    let pending: Array<{ DeleteRequest: { Key: { pk: string; sk: string } } }> = keys
      .slice(i, i + 25)
      .map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; pending.length && attempt < 5; attempt++) {
      const out = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [tables.sales]: pending } }),
      );
      pending = (out.UnprocessedItems?.[tables.sales] ?? []) as typeof pending;
    }
    if (pending.length) throw new Error("sales rows not deleted");
  }
}

export const putArtifact = (a: SalesArtifact) =>
  ddb.send(new PutCommand({ TableName: tables.sales, Item: artifactItem(a) }));

/** The demo back to how it starts: its rows (and only its rows) replaced. */
export async function resetDemo(rows: SalesRows, now = Date.now(), seed = true): Promise<void> {
  await deleteKeys([
    ...rows.records.filter((r) => r.demo || isDemoId(r.id)).map((r) => recordKey(r.id)),
    ...rows.artifacts.filter((a) => a.demo || isDemoId(a.id)).map((a) => artifactKey(a.id)),
    ...rows.changes.filter((c) => c.demo || isDemoId(c.recordId)).map(changeKey),
  ]);
  // `seed` false: the demo is taken away and nothing put back.
  if (!seed) return;
  const demo = demoSalesSeed(now);
  await putRows([
    ...demo.records.map(recordItem),
    ...demo.artifacts.map(artifactItem),
    ...demo.changes.map(changeItem),
  ]);
}

export interface SalesDirectory {
  /** The team: who a record can belong to (never externals). */
  people: Array<{ userId: string; name: string }>;
  /** Everyone's name, externals included (a project's clients). */
  names: Map<string, string>;
  guests: Set<string>;
}

export async function salesDirectory(): Promise<SalesDirectory> {
  const dir: SalesDirectory = { people: [], names: new Map(), guests: new Set() };
  const pages = paginateScan(
    { client: ddb },
    {
      TableName: tables.users,
      ProjectionExpression: "userId, displayName, email, #role",
      ExpressionAttributeNames: { "#role": "role" },
    },
  );
  for await (const page of pages) {
    for (const u of page.Items ?? []) {
      const userId = String(u.userId);
      const name = String(u.displayName || String(u.email ?? "").split("@")[0] || u.userId);
      dir.names.set(userId, name);
      if (u.role === "guest") dir.guests.add(userId);
      else dir.people.push({ userId, name });
    }
  }
  dir.people.sort((a, b) => a.name.localeCompare(b.name));
  return dir;
}

/** The team: who a record can belong to (never externals). */
export async function salesPeople(): Promise<Array<{ userId: string; name: string }>> {
  return (await salesDirectory()).people;
}

/**
 * Phase 75: the project channels `viewer` may see (their own channels; an
 * admin, all), each with its hours from the time log. A channel counts as a
 * project when hours were logged in it or the client's people are in it.
 * Billed amounts only for an admin (bill rates are theirs to see).
 */
export async function loadProjects(
  viewer: { userId: string; role: Role },
  dir: SalesDirectory,
  now = Date.now(),
): Promise<SalesProject[]> {
  const channels: Channel[] = [];
  for await (const page of paginateScan({ client: ddb }, { TableName: tables.channels })) {
    for (const item of page.Items ?? []) {
      const c = item as Channel;
      if (c.type === "dm" || c.archived) continue;
      if (canSeeChannel(c, viewer.userId, viewer.role)) channels.push(c);
    }
  }
  const ids = new Set(channels.map((c) => c.channelId));
  const entries = new Map<string, Array<{ userId: string; date: string; minutes: number }>>();
  const bill = new Map<string, Record<string, number>>();
  const clients = new Map<string, string[]>();
  for await (const page of paginateScan({ client: ddb }, { TableName: tables.timeLog })) {
    for (const row of page.Items ?? []) {
      const channelId = String(row.channelId);
      if (!ids.has(channelId)) continue;
      const sk = String(row.sk);
      if (sk.startsWith("entry#")) {
        const list = entries.get(channelId) ?? [];
        list.push({
          userId: String(row.userId),
          date: String(row.date),
          minutes: Number(row.minutes) || 0,
        });
        entries.set(channelId, list);
      } else if (sk.startsWith("bill#") && typeof row.hourlyRate === "number") {
        bill.set(channelId, { ...bill.get(channelId), [sk.slice(5)]: row.hourlyRate });
      } else if (sk === "clients" && Array.isArray(row.clientIds)) {
        clients.set(channelId, row.clientIds.map(String));
      }
    }
  }
  const withMoney = viewer.role === "admin";
  return channels
    .map((c) => {
      const hasExternals = (c.members ?? []).some((m) => dir.guests.has(m));
      const logged = entries.get(c.channelId) ?? [];
      if (logged.length === 0 && !hasExternals) return null;
      return projectSummary(c, logged, bill.get(c.channelId) ?? {}, now, {
        hasExternals,
        clientNames: (clients.get(c.channelId) ?? []).map((id) => dir.names.get(id) ?? id),
        withMoney,
      });
    })
    .filter((p): p is SalesProject => p !== null)
    .sort((a, b) => b.hours30 - a.hours30 || a.name.localeCompare(b.name));
}
