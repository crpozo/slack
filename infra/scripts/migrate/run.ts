import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  paginateListUsers,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CopyObjectCommand,
  HeadObjectCommand,
  NotFound,
  paginateListObjectsV2,
  S3Client,
} from "@aws-sdk/client-s3";
import { BatchWriteCommand, DynamoDBDocumentClient, paginateScan } from "@aws-sdk/lib-dynamodb";
import { pruneExcluded, type Dataset, type Item } from "./prune";
import { createRemapper, type Remapper } from "./remap";

/** Tables holding user data. `connections` and `push-subscriptions` rebuild themselves. */
export const TABLES = ["users", "channels", "messages", "boards", "tasks"] as const;

export interface Clients {
  cfn: CloudFormationClient;
  cognito: CognitoIdentityProviderClient;
  ddb: DynamoDBDocumentClient;
  s3: S3Client;
}

export interface MigrateOptions {
  from: { stack: string; stage: string };
  to: { stack: string; stage: string };
  /** `false` (default): read everything, write nothing, report what would happen. */
  apply: boolean;
  /** Asked for each person who has no account in the target pool yet (only with `apply`). */
  passwordFor: (email: string) => Promise<string>;
  log: (line: string) => void;
}

export interface MigrateReport {
  users: Array<{ email: string; oldId: string; newId: string; created: boolean }>;
  /** Directory users with no account left in the source pool: none of their data is copied. */
  excluded: Array<{ userId: string; email: string }>;
  items: Record<(typeof TABLES)[number], number>;
  /** Rows left out because they belonged to excluded users. */
  dropped: Record<(typeof TABLES)[number], number>;
  files: { copied: number; skipped: number; excluded: number };
}

interface StackInfo {
  userPoolId: string;
  attachmentsBucket: string;
}

async function stackInfo(cfn: CloudFormationClient, stack: string): Promise<StackInfo> {
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  const outputs = Object.fromEntries(
    (Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]),
  );
  const userPoolId = outputs.UserPoolId;
  const attachmentsBucket = outputs.AttachmentsBucket;
  if (!userPoolId || !attachmentsBucket) {
    throw new Error(`${stack} has no UserPoolId/AttachmentsBucket outputs: is it deployed?`);
  }
  return { userPoolId, attachmentsBucket };
}

const attr = (user: UserType, name: string) => user.Attributes?.find((a) => a.Name === name)?.Value;

/** email (lowercased) → sub, for everyone in a pool. */
async function poolUsers(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
): Promise<Map<string, string>> {
  const users = new Map<string, string>();
  for await (const page of paginateListUsers({ client: cognito }, { UserPoolId: userPoolId })) {
    for (const user of page.Users ?? []) {
      const email = attr(user, "email")?.toLowerCase();
      const sub = attr(user, "sub");
      if (email && sub) users.set(email, sub);
    }
  }
  return users;
}

/** Placeholder id for an account a dry run would create (no `_`: DM ids split on it). */
const pendingId = (n: number) => `pending-user-${n}`;

async function mapUsers(
  clients: Clients,
  source: StackInfo,
  target: StackInfo,
  opts: MigrateOptions,
): Promise<MigrateReport["users"]> {
  const [from, existing] = await Promise.all([
    poolUsers(clients.cognito, source.userPoolId),
    poolUsers(clients.cognito, target.userPoolId),
  ]);
  const result: MigrateReport["users"] = [];
  for (const [email, oldId] of from) {
    const known = existing.get(email);
    if (known) {
      result.push({ email, oldId, newId: known, created: false });
      continue;
    }
    if (!opts.apply) {
      result.push({ email, oldId, newId: pendingId(result.length + 1), created: true });
      continue;
    }
    // Sequential on purpose: one password prompt at a time.
    const password = await opts.passwordFor(email);
    const { User } = await clients.cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: target.userPoolId,
        Username: email,
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
        MessageAction: "SUPPRESS",
      }),
    );
    await clients.cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: target.userPoolId,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
    const newId = User ? attr(User, "sub") : undefined;
    if (!newId) throw new Error(`Cognito returned no sub for ${email}`);
    result.push({ email, oldId, newId, created: true });
  }
  return result;
}

const BATCH = 25;

async function putAll(
  ddb: DynamoDBDocumentClient,
  table: string,
  items: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH) {
    let requests: Record<string, unknown>[] = items
      .slice(i, i + BATCH)
      .map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt > 5)
        throw new Error(`${table}: DynamoDB kept ${requests.length} writes unprocessed`);
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      const { UnprocessedItems } = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [table]: requests } }),
      );
      requests = (UnprocessedItems?.[table] ?? []) as Record<string, unknown>[];
    }
  }
}

async function scanTable(ddb: DynamoDBDocumentClient, table: string): Promise<Item[]> {
  const items: Item[] = [];
  for await (const page of paginateScan({ client: ddb }, { TableName: table })) {
    items.push(...(page.Items ?? []));
  }
  return items;
}

async function loadDataset(ddb: DynamoDBDocumentClient, stage: string): Promise<Dataset> {
  const entries = await Promise.all(
    TABLES.map(async (name) => [name, await scanTable(ddb, `slack-${stage}-${name}`)] as const),
  );
  return Object.fromEntries(entries) as unknown as Dataset;
}

/** S3 CopySource: bucket + URL-encoded key (each segment, keeping the slashes). */
const copySource = (bucket: string, key: string) =>
  `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

async function copyFiles(
  s3: S3Client,
  source: StackInfo,
  target: StackInfo,
  opts: MigrateOptions,
  remap: Remapper,
  skipFile: (key: string) => boolean,
): Promise<MigrateReport["files"]> {
  let copied = 0;
  let skipped = 0;
  let excluded = 0;
  const pages = paginateListObjectsV2(
    { client: s3 },
    { Bucket: source.attachmentsBucket, Prefix: "attachments/" },
  );
  for await (const page of pages) {
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue;
      if (skipFile(object.Key)) {
        excluded++;
        continue;
      }
      const key = remap.string(object.Key);
      // Already there with the same size (an earlier run): nothing to do.
      try {
        const head = await s3.send(
          new HeadObjectCommand({ Bucket: target.attachmentsBucket, Key: key }),
        );
        if (head.ContentLength === object.Size) {
          skipped++;
          continue;
        }
      } catch (err) {
        if (!(err instanceof NotFound)) throw err;
      }
      if (opts.apply) {
        await s3.send(
          new CopyObjectCommand({
            Bucket: target.attachmentsBucket,
            Key: key,
            CopySource: copySource(source.attachmentsBucket, object.Key),
          }),
        );
      }
      copied++;
    }
  }
  opts.log(
    `  files: ${copied} ${opts.apply ? "copied" : "to copy"}, ${skipped} already in place, ${excluded} left out`,
  );
  return { copied, skipped, excluded };
}

/**
 * Copies every user's data from one stack to another, giving each person an
 * account in the target pool (Cognito can't export passwords, and the target
 * pool assigns new user ids, so every id in the data is rewritten). Never
 * writes to or deletes from the source. Safe to run again: accounts are reused,
 * rows are overwritten with the same content, files already copied are skipped.
 */
export async function migrate(clients: Clients, opts: MigrateOptions): Promise<MigrateReport> {
  const [source, target] = await Promise.all([
    stackInfo(clients.cfn, opts.from.stack),
    stackInfo(clients.cfn, opts.to.stack),
  ]);
  opts.log(
    `${opts.apply ? "MIGRATING" : "DRY RUN (nothing is written)"}: ${opts.from.stack} → ${opts.to.stack}`,
  );

  opts.log("Accounts:");
  const users = await mapUsers(clients, source, target, opts);
  for (const u of users) {
    const verb = u.created ? (opts.apply ? "created in" : "will be created in") : "already in";
    opts.log(`  ${u.email}: ${verb} ${opts.to.stack}`);
  }
  const remap = createRemapper(new Map(users.map((u) => [u.oldId, u.newId])));

  const dataset = await loadDataset(clients.ddb, opts.from.stage);
  // Deleted from the source pool (e.g. test accounts): leave everything of theirs behind.
  const mapped = new Set(users.map((u) => u.oldId));
  const excluded = dataset.users
    .filter((u) => !mapped.has(String(u.userId)))
    .map((u) => ({ userId: String(u.userId), email: typeof u.email === "string" ? u.email : "" }));
  if (excluded.length > 0) {
    opts.log("Left out (no account in the source pool any more):");
    for (const u of excluded) opts.log(`  ${u.email || u.userId}: none of their data is copied`);
  }
  const pruned = pruneExcluded(dataset, new Set(excluded.map((u) => u.userId)));

  opts.log("Data:");
  const items = {} as MigrateReport["items"];
  for (const name of TABLES) {
    const rows = pruned.data[name].map((item) => remap.value(item));
    if (opts.apply) await putAll(clients.ddb, `slack-${opts.to.stage}-${name}`, rows);
    items[name] = rows.length;
    const left = pruned.dropped[name] ? `, ${pruned.dropped[name]} left out` : "";
    opts.log(`  ${name}: ${rows.length} ${opts.apply ? "copied" : "to copy"}${left}`);
  }

  const files = await copyFiles(clients.s3, source, target, opts, remap, pruned.skipFile);
  return { users, excluded, items, dropped: pruned.dropped, files };
}
