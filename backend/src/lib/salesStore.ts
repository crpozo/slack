import { BatchWriteCommand, paginateQuery, paginateScan, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
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

/** The team: who a record can belong to (never externals). */
export async function salesPeople(): Promise<Array<{ userId: string; name: string }>> {
  const people: Array<{ userId: string; name: string }> = [];
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
      if (u.role === "guest") continue;
      people.push({
        userId: String(u.userId),
        name: String(u.displayName || String(u.email ?? "").split("@")[0] || u.userId),
      });
    }
  }
  return people.sort((a, b) => a.name.localeCompare(b.name));
}
