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
  items: Record<(typeof TABLES)[number], number>;
  files: { copied: number; skipped: number };
  /** Ids found in data with no account to map them to (left unchanged). */
  unmappedIds: number;
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

async function copyTable(
  ddb: DynamoDBDocumentClient,
  name: (typeof TABLES)[number],
  opts: MigrateOptions,
  remap: Remapper,
): Promise<number> {
  const source = `slack-${opts.from.stage}-${name}`;
  const target = `slack-${opts.to.stage}-${name}`;
  const items: Record<string, unknown>[] = [];
  for await (const page of paginateScan({ client: ddb }, { TableName: source })) {
    items.push(...(page.Items ?? []).map((item) => remap.value(item)));
  }
  if (opts.apply) await putAll(ddb, target, items);
  opts.log(
    `  ${name}: ${items.length} ${opts.apply ? "copied" : "to copy"} (${source} → ${target})`,
  );
  return items.length;
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
): Promise<MigrateReport["files"]> {
  let copied = 0;
  let skipped = 0;
  const pages = paginateListObjectsV2(
    { client: s3 },
    { Bucket: source.attachmentsBucket, Prefix: "attachments/" },
  );
  for await (const page of pages) {
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue;
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
  opts.log(`  files: ${copied} ${opts.apply ? "copied" : "to copy"}, ${skipped} already in place`);
  return { copied, skipped };
}

/** Directory users (source `users` table) with no Cognito account to map them to. */
async function countUnmapped(
  ddb: DynamoDBDocumentClient,
  opts: MigrateOptions,
  users: MigrateReport["users"],
): Promise<number> {
  const known = new Set(users.map((u) => u.oldId));
  let count = 0;
  const pages = paginateScan(
    { client: ddb },
    { TableName: `slack-${opts.from.stage}-users`, ProjectionExpression: "userId" },
  );
  for await (const page of pages) {
    for (const item of page.Items ?? []) if (!known.has(String(item.userId))) count++;
  }
  return count;
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

  opts.log("Data:");
  const items = {} as MigrateReport["items"];
  for (const name of TABLES) items[name] = await copyTable(clients.ddb, name, opts, remap);

  const files = await copyFiles(clients.s3, source, target, opts, remap);

  const unmappedIds = await countUnmapped(clients.ddb, opts, users);
  if (unmappedIds > 0) {
    opts.log(
      `  note: ${unmappedIds} user(s) in the directory have no account in ${opts.from.stack}; their data keeps the old ids`,
    );
  }
  return { users, items, files, unmappedIds };
}
