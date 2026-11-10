import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  blipKey,
  type CreateBlipInput,
  type RadarBlip,
  type RadarProposal,
  type RadarRing,
  type UpdateBlipInput,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { ddb, tables } from "./ddb";

/** The two entities of the `tech-radar` table, told apart by the partition key. */
export const BLIP_PK = "BLIP";
export const PROPOSAL_PK = "PROPOSAL";
/** One row per scanner with the time of its last run (`id` "last", or "discovery"). */
export const SCAN_PK = "SCAN";
/** The news scan's row (Phase 56). */
export const NEWS_SCAN_ID = "last";
/** The Discovery Engine's row (Phase 60). */
export const DISCOVERY_SCAN_ID = "discovery";

type Row = Record<string, unknown>;

async function queryAll(pk: string): Promise<Row[]> {
  const rows: Row[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tables.techRadar,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ExclusiveStartKey: key,
      }),
    );
    rows.push(...((page.Items ?? []) as Row[]));
    key = page.LastEvaluatedKey;
  } while (key);
  return rows;
}

const stripPk = <T>(row: Row): T => {
  const rest = { ...row };
  delete rest.pk;
  return rest as T;
};

export async function listBlips(): Promise<RadarBlip[]> {
  const blips = (await queryAll(BLIP_PK)).map((r) => stripPk<RadarBlip>(r));
  return blips.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getBlip(id: string): Promise<RadarBlip | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.techRadar, Key: { pk: BLIP_PK, id } }),
  );
  return Item ? stripPk<RadarBlip>(Item as Row) : null;
}

/** A new blip; the id is derived from the name so the same technology can't be added twice. */
export function newBlip(input: CreateBlipInput, by: string, now = Date.now()): RadarBlip {
  return {
    id: blipKey(input.name),
    name: input.name,
    quadrant: input.quadrant,
    ring: input.ring,
    description: input.description ?? "",
    previousRing: null,
    ...(input.link && { link: input.link }),
    ...(input.meta && Object.keys(input.meta).length > 0 && { meta: input.meta }),
    createdAt: now,
    updatedAt: now,
    updatedBy: by,
  };
}

/** @returns `false` when a blip with that id (same name, spelled anyhow) already exists. */
export async function putBlipIfAbsent(blip: RadarBlip): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tables.techRadar,
        Item: { pk: BLIP_PK, ...blip },
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

/**
 * Applies `patch` to the blip. A different `ring` is a move: the current ring
 * becomes `previousRing` and `movedAt` is set, so the chart can draw it.
 * @returns the blip as it is now, or `null` if it doesn't exist.
 */
export async function updateBlip(
  id: string,
  patch: UpdateBlipInput,
  by: string,
  now = Date.now(),
): Promise<RadarBlip | null> {
  const current = await getBlip(id);
  if (!current) return null;
  const names: Record<string, string> = { "#updatedAt": "updatedAt", "#updatedBy": "updatedBy" };
  const values: Record<string, unknown> = { ":updatedAt": now, ":updatedBy": by };
  const sets = ["#updatedAt = :updatedAt", "#updatedBy = :updatedBy"];
  const removes: string[] = [];
  const assign = (key: string, value: unknown) => {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  };
  if (patch.name !== undefined && patch.name !== current.name) assign("name", patch.name);
  if (patch.quadrant !== undefined && patch.quadrant !== current.quadrant) {
    assign("quadrant", patch.quadrant);
  }
  if (patch.description !== undefined && patch.description !== current.description) {
    assign("description", patch.description);
  }
  if (patch.link !== undefined) {
    if (patch.link) assign("link", patch.link);
    else if (current.link) {
      names["#link"] = "link";
      removes.push("#link");
    }
  }
  if (patch.meta !== undefined) {
    if (Object.keys(patch.meta).length > 0) assign("meta", patch.meta);
    else if (current.meta) {
      names["#meta"] = "meta";
      removes.push("#meta");
    }
  }
  if (patch.ring !== undefined && patch.ring !== current.ring) {
    assign("ring", patch.ring);
    assign("previousRing", current.ring);
    assign("movedAt", now);
  }
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: tables.techRadar,
      Key: { pk: BLIP_PK, id },
      UpdateExpression: [
        `SET ${sets.join(", ")}`,
        removes.length ? `REMOVE ${removes.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      ConditionExpression: "attribute_exists(id)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }),
  );
  return Attributes ? stripPk<RadarBlip>(Attributes as Row) : null;
}

export async function deleteBlip(id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: tables.techRadar, Key: { pk: BLIP_PK, id } }));
}

// --- Proposals ------------------------------------------------------------------

export async function listProposals(status?: RadarProposal["status"]): Promise<RadarProposal[]> {
  const all = (await queryAll(PROPOSAL_PK)).map((r) => stripPk<RadarProposal>(r));
  const list = status ? all.filter((p) => p.status === status) : all;
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getProposal(id: string): Promise<RadarProposal | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.techRadar, Key: { pk: PROPOSAL_PK, id } }),
  );
  return Item ? stripPk<RadarProposal>(Item as Row) : null;
}

export function newProposal(
  fields: Omit<RadarProposal, "id" | "status" | "createdAt">,
  now = Date.now(),
): RadarProposal {
  return { id: ulid(), status: "pending", createdAt: now, ...fields };
}

export async function putProposal(proposal: RadarProposal): Promise<void> {
  await ddb.send(
    new PutCommand({ TableName: tables.techRadar, Item: { pk: PROPOSAL_PK, ...proposal } }),
  );
}

/** @returns `false` when a proposal with that id is already there (a retried run). */
export async function putProposalIfAbsent(proposal: RadarProposal): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tables.techRadar,
        Item: { pk: PROPOSAL_PK, ...proposal },
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

/** Marks a pending proposal applied or dismissed; `null` when it isn't pending any more. */
export async function resolveProposal(
  id: string,
  status: "applied" | "dismissed",
  by: string,
  now = Date.now(),
): Promise<RadarProposal | null> {
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: tables.techRadar,
        Key: { pk: PROPOSAL_PK, id },
        UpdateExpression: "SET #status = :status, resolvedBy = :by, resolvedAt = :at",
        ConditionExpression: "attribute_exists(id) AND #status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":by": by,
          ":at": now,
          ":pending": "pending",
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return Attributes ? stripPk<RadarProposal>(Attributes as Row) : null;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return null;
    throw err;
  }
}

/** Old resolved proposals are noise: drop them after a month (called by the scanner). */
export const PROPOSAL_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export async function pruneProposals(now = Date.now()): Promise<number> {
  const stale = (await listProposals()).filter(
    (p) => p.status !== "pending" && now - (p.resolvedAt ?? p.createdAt) > PROPOSAL_KEEP_MS,
  );
  await Promise.all(
    stale.map((p) =>
      ddb.send(
        new DeleteCommand({ TableName: tables.techRadar, Key: { pk: PROPOSAL_PK, id: p.id } }),
      ),
    ),
  );
  return stale.length;
}

// --- Scan bookkeeping -------------------------------------------------------------

export async function lastScanAt(id = NEWS_SCAN_ID): Promise<number | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.techRadar, Key: { pk: SCAN_PK, id } }),
  );
  return typeof Item?.at === "number" ? Item.at : null;
}

export async function recordScan(
  at: number,
  summary: Record<string, unknown>,
  id = NEWS_SCAN_ID,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tables.techRadar,
      Item: { pk: SCAN_PK, id, at, ...summary },
    }),
  );
}

/** Moves a blip to `ring` on behalf of an applied proposal. */
export async function moveBlip(id: string, ring: RadarRing, by: string): Promise<RadarBlip | null> {
  return updateBlip(id, { ring }, by);
}
