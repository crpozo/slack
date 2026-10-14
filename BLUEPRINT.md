# BLUEPRINT — MindfulTech internal Slack (MVP v0.1.0)

**Date:** 2026-10-08 · **MVP delivery:** 2026-10-09 · **Repo:** https://github.com/crpozo/slack.git
**How to use this document:** each "Phase" in section 4 is a self-contained prompt for Claude Opus 5.5. Give them to it in order, one at a time, and ask it not to move on to the next one until the current one builds and passes its tests.

---

## 0. Scope decisions to make it by tomorrow

The requirements document describes the full product. In 24 hours we only fit what makes the app *usable between two people*; everything else is explicitly out and scheduled for v0.2.

| In the MVP (tomorrow) | Deferred to v0.2+ |
|---|---|
| Cognito login (email + password), persistent session | Threads |
| Public channels: `#general` by default, create, list | Rename / archive channels |
| 1:1 DMs (a channel with `type=dm`) | Reactions |
| Real-time messages over WebSocket (< 1 s) | Editing and deleting messages |
| Basic formatting (bold, italic, code, links) via lightweight markdown | Text search |
| Backward-paginated history (infinite scroll) | Online/offline presence |
| Attachments: upload via presigned URL (PUT), inline image preview, download (signed GET), 25 MB limit | "Typing…" (create the `typing` route but no UI) |
| Per-channel unread badge (computed on the client, `lastReadTs` in localStorage) | System notifications, `@` mentions |
| Reconnection with backoff | WebRTC calls + TURN |
| Production deploy at `slack.mindfultech.ec` / `ws.mindfultech.ec` | Tauri desktop app (optional Phase 5 if there is time left) |
| Handler unit tests + CI on PRs | Integration tests against the dev stack, Playwright E2E |
| AWS Budgets, tags, log retention | AI agent with Bedrock |

**Golden rule:** nothing gets built that is not in the left column. If Opus proposes something from the right column, it is rejected.

---

## 1. Architecture Overview

The diagram is followed exactly: 7 components, fully serverless, region `us-east-1`.

```
Clients (browser / Tauri)
   │ https                     │ login (SRP)              │ wss?token=<idToken>
   ▼                           ▼                          ▼
S3 + CloudFront          Cognito User Pool         API Gateway WebSocket
(static SPA)             (2 users, no              ws.mindfultech.ec
slack.mindfultech.ec      self-signup)                    │ invokes
                                                          ▼
                                                   Lambda (Node 20, ARM, 256 MB)
                                                   authorizer · connect · disconnect
                                                   message · history · presign · channel
                                                     │ reads/writes         │ signs URLs
                                                     ▼                      ▼
                                                 DynamoDB              S3 attachments
                                                 messages              (private, presigned
                                                 connections (TTL)      PUT/GET)
                                                 channels
```

### Session flow

1. The browser loads the SPA from CloudFront (private bucket with OAC).
2. Login against Cognito with `aws-amplify/auth`. Amplify stores the tokens in localStorage and refreshes them on its own → persistent session.
3. The client opens **a single** WebSocket to `wss://ws.mindfultech.ec?token=<idToken>`.
4. `$connect` goes through the **Lambda REQUEST authorizer**, which validates the JWT with `aws-jwt-verify` and returns `userId`/`email` in the context. No valid JWT → 401, the connection is never opened.
5. `connect` stores `{connectionId, userId, ttl}` in `connections`.
6. Every client message is a JSON `{ "action": "...", ... }`. API Gateway routes on `$request.body.action` to the matching Lambda.
7. `message` writes to `messages` and fans out with `@connections` (PostToConnection) to every live connection. If a connection returns 410 Gone, it is deleted from `connections`.
8. `history` queries `messages` by `channelId` with `ScanIndexForward=false`, `Limit=50` and `ExclusiveStartKey` to paginate backwards.
9. `presign` generates an S3 PUT (upload) or GET (download) URL that expires in 5 min. The client uploads/downloads directly to/from S3; Lambda never touches the binary.
10. `$disconnect` deletes the row from `connections` (with a 2 h TTL as a safety net).

### Data model (DynamoDB on-demand, no GSIs, no streams, no PITR)

| Table | PK | SK | Attributes |
|---|---|---|---|
| `slack-messages` | `channelId` (S) | `sk` (S) = `${epochMs}#${ulid}` | `messageId`, `userId`, `userEmail`, `text`, `attachments[]` (`{key, name, size, contentType}`), `createdAt` |
| `slack-connections` | `connectionId` (S) | — | `userId`, `userEmail`, `connectedAt`, `ttl` (N, epoch s, +2 h) |
| `slack-channels` | `channelId` (S) | — | `name`, `type` (`public` \| `dm`), `createdBy`, `createdAt`, `archived` (bool) |

- `channelId` of a public channel: `ch_<ulid>`; `#general` has the fixed id `ch_general` (seeded on deploy).
- `channelId` of a DM: `dm_<userIdA>_<userIdB>` with the ids sorted alphabetically → always the same id for the pair.
- Attachments in S3: key `attachments/<channelId>/<ulid>-<sanitizedName>`. Bucket with a lifecycle rule to Glacier IR at 90 days and CORS for PUT from the SPA origin.

### WebSocket protocol (shared contract in `packages/shared`)

**Client → server** (`action` is the route key):

| action | payload | response |
|---|---|---|
| `message` | `{ channelId, text, attachments?, clientId }` | broadcast `message.new` to everyone (sender included) |
| `history` | `{ channelId, cursor? }` | `history.page { channelId, items[], nextCursor }` to the sender only |
| `channel` | `{ op: "list" }` \| `{ op: "create", name }` \| `{ op: "dm", withUserId }` | `channel.list { channels[] }` broadcast after create/dm |
| `presign` | `{ op: "put", channelId, name, contentType, size }` \| `{ op: "get", key }` | `presign.result { url, key, requestId }` to the sender only |
| `typing` | `{ channelId }` | (route created, no-op handler in the MVP) |

**Server → client:** `{ "type": "message.new" | "history.page" | "channel.list" | "presign.result" | "error", ...payload }`.

Every payload is validated with **zod** in the handler; invalid payload → `{type:"error", code:"BAD_REQUEST"}` to the sender.

### Cost constraints the stack must meet from the very first `cdk deploy`

- Lambda: `architecture: ARM_64`, `memorySize: 256`, `runtime: NODEJS_20_X`, esbuild bundling (`NodejsFunction`), no VPC, no provisioned concurrency.
- CloudWatch: `logRetention: 7 days`, INFO level (never DEBUG in prod).
- CloudFront: `PriceClass.PRICE_CLASS_100`, compression, 1-year cache for hashed assets, `index.html` uncached.
- DynamoDB: `BillingMode.PAY_PER_REQUEST`, TTL on `connections`, no PITR.
- Cognito: standard user pool, `selfSignUpEnabled: false`, no advanced security.
- `Tags.of(app).add("project", "slack")` across the whole CDK app.
- `aws_budgets.CfnBudget` of USD 5 with alerts at 80 % and 100 % to carlos@mindfultech.ec.
- Secrets/config in standard SSM Parameter Store (if ever needed); nothing in Secrets Manager.
- Two stacks from the same code: `SlackDev` (destroyed at the end of each session) and `SlackProd` (the only permanent one).

---

## 2. Project Structure (Scaffolding)

Monorepo with **pnpm workspaces**. A single `pnpm install`, a single `pnpm deploy:prod`.

```
slack/
├── .github/
│   └── workflows/
│       ├── ci.yml                 # lint + typecheck + unit tests on every PR
│       └── deploy.yml             # merge to main → cdk deploy SlackProd + S3 sync + CloudFront invalidation
├── apps/
│   ├── web/                       # React 18 + Vite + TypeScript + Tailwind (SPA, no SSR)
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── .env.example           # VITE_WS_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx            # router: /login | /app/:channelId
│   │       ├── lib/
│   │       │   ├── auth.ts        # aws-amplify/auth wrapper: signIn, getToken, signOut
│   │       │   ├── ws.ts          # WebSocket client: connection, backoff, send(action), on(type)
│   │       │   ├── upload.ts      # presign → PUT to S3 → returns attachment
│   │       │   └── markdown.ts    # bold/italic/code/links (regex, no heavy lib)
│   │       ├── store/
│   │       │   └── index.ts       # zustand: user, channels, messagesByChannel, cursors, unread, activeChannel
│   │       ├── components/
│   │       │   ├── LoginPage.tsx
│   │       │   ├── Sidebar.tsx    # channel list + DMs + unread badge + create channel
│   │       │   ├── ChannelView.tsx# header + MessageList + Composer
│   │       │   ├── MessageList.tsx# upward infinite scroll, IntersectionObserver
│   │       │   ├── MessageItem.tsx# initial avatar, name, time, rendered text, attachments
│   │       │   ├── Composer.tsx   # textarea, Enter sends, Shift+Enter newline, drag&drop + paste
│   │       │   └── Attachment.tsx # inline img (signed GET) or download chip
│   │       └── styles.css
│   └── desktop/                   # (Phase 5, optional) Tauri app that loads https://slack.mindfultech.ec
├── packages/
│   └── shared/                    # protocol types + zod schemas, used by web and backend
│       └── src/
│           ├── protocol.ts        # ClientAction (zod), ServerEvent (types), constants
│           └── ids.ts             # dmChannelId(a,b), isDm(), GENERAL_CHANNEL_ID
├── backend/
│   ├── src/
│   │   ├── handlers/
│   │   │   ├── authorizer.ts      # REQUEST authorizer: validates ?token= with aws-jwt-verify
│   │   │   ├── connect.ts
│   │   │   ├── disconnect.ts
│   │   │   ├── message.ts
│   │   │   ├── history.ts
│   │   │   ├── channel.ts
│   │   │   ├── presign.ts
│   │   │   └── typing.ts          # no-op that returns 200
│   │   └── lib/
│   │       ├── ddb.ts             # DocumentClient + table names from env
│   │       ├── broadcast.ts       # postToAll(event) with 410 Gone cleanup
│   │       ├── s3.ts              # presign put/get
│   │       ├── response.ts        # ok(), badRequest(), reply(connectionId, event)
│   │       └── logger.ts          # JSON console, level from env LOG_LEVEL
│   ├── test/                      # Vitest + aws-sdk-client-mock
│   │   ├── message.test.ts
│   │   ├── history.test.ts
│   │   ├── channel.test.ts
│   │   ├── presign.test.ts
│   │   ├── connect.test.ts
│   │   └── authorizer.test.ts
│   └── vitest.config.ts
├── infra/                         # AWS CDK v2 (TypeScript)
│   ├── bin/slack.ts               # instantiates SlackStack with stage = dev | prod
│   ├── lib/
│   │   ├── slack-stack.ts         # wires up the constructs
│   │   ├── auth.ts                # Cognito User Pool + client
│   │   ├── data.ts                # 3 DynamoDB tables
│   │   ├── storage.ts             # attachments bucket (CORS, lifecycle) + web bucket
│   │   ├── api.ts                 # WebSocketApi + routes + Lambdas + authorizer + custom domain
│   │   ├── web.ts                 # CloudFront + OAC + BucketDeployment + custom domain
│   │   └── cost.ts                # USD 5 budget, tags
│   ├── cdk.json
│   └── scripts/seed-general.ts    # creates ch_general if missing (runs post-deploy)
├── docs/
│   └── requerimientos.md          # the original document
├── BLUEPRINT.md                   # this file
├── README.md                      # git clone + README = project up and running
├── package.json                   # root scripts: dev, test, lint, deploy:dev, deploy:prod, destroy:dev
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── .gitignore
```

**Root scripts (package.json):**

```json
{
  "scripts": {
    "dev": "pnpm --filter web dev",
    "build": "pnpm -r build",
    "test": "pnpm --filter backend test",
    "lint": "pnpm -r lint && pnpm -r typecheck",
    "deploy:dev": "pnpm --filter infra cdk deploy SlackDev --require-approval never",
    "deploy:prod": "pnpm --filter infra cdk deploy SlackProd --require-approval never",
    "destroy:dev": "pnpm --filter infra cdk destroy SlackDev --force"
  }
}
```

---

## 3. Branching strategy (simplified trunk-based)

> **Change (Oct 8):** `develop` is removed. All `feature/*` branches start from `main` and merge straight back into `main` via PR. There are no `release/*` or `hotfix/*` branches: a version is a tag on `main`.

### Branches

| Branch | Role | Protection |
|---|---|---|
| `main` | The only permanent branch. Must always build and pass tests. Receives every PR. | Protected: PR required, green CI, 1 approval (Carlos or Rene) |
| `feature/<phase>-<name>` | One branch per Phase of the plan (section 4). Starts from `main`, dies once merged. | — |
| `fix/<issue>` | A bug found during testing. Starts from `main`, goes back to `main` via PR. | — |

### Commit timeline

```
TODAY (Oct 8)
  main ──●  "chore: initial commit"
         ├── feature/f1-scaffold-infra   ──PR──►  main   ← Phase 1
         ├── feature/f2-backend-handlers ──PR──►  main   ← Phase 2
         └── feature/f3-web-client       ──PR──►  main   ← Phase 3

TOMORROW (Oct 9)
  main ──● feature/f4-prod-deploy ──PR──► main  →  tag v0.1.0
                                                  └── GitHub Actions deploy.yml → SlackProd
```

### Working rules

1. **Conventional commits**: `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `infra:`. One commit per logical unit; Opus must commit when it finishes each sub-step of a Phase.
2. **Squash merge** of `feature/*` and `fix/*` → `main` (clean history, one commit per PR).
3. **CI (`ci.yml`) runs on every PR to `main`**: `pnpm lint` + `pnpm test`. Nothing is merged while red.
4. **Deploy (`deploy.yml`) runs on push to `main`**: web build → `cdk deploy SlackProd` → `aws s3 sync` → CloudFront invalidation. Credentials via OIDC (an IAM role GitHub Actions can assume), never access keys in secrets. Since every merged PR goes to production, it is tested on `SlackDev` before being approved.
5. **Dev stack**: every work session ends with `pnpm destroy:dev`. It is on the PR checklist.
6. Carlos and Rene work on different features at the same time (e.g. Rene on F2 backend, Carlos on F3 web) and stay in sync through the `packages/shared` contract (F1 locks it down first). Before opening the PR, each of them pulls the changes from `main` into their branch.
7. Every bug found during manual testing → GitHub issue → `fix/<issue>` branch from `main`.
8. **Versions**: `git tag v0.1.0 && git push origin v0.1.0` on the `main` commit being released.

### Getting-started commands

```bash
git clone https://github.com/crpozo/slack.git && cd slack
# on GitHub: Settings → Branches → protect main (require PR + status checks)
git checkout main && git pull
git checkout -b feature/<phase>-<name>
```

---

## 4. Action Plan for Opus 5.5 — Code Phases

Each phase is a prompt. Paste it as is, preceded by: *"Read BLUEPRINT.md at the repo root. You are on the `feature/<...>` branch. Implement exactly Phase N. Do not implement anything from later phases or from the 'Deferred to v0.2+' column. When you finish, run the acceptance criteria and make conventional commits."*

Estimated times assuming Opus writes the code and you supervise: F1 2 h · F2 3 h · F3 5 h · F4 2 h · F5 2 h (optional). Total ≈ 12–14 h of actual work.

---

### PHASE 1 — Monorepo scaffold + shared contract + deployable CDK infrastructure

**Branch:** `feature/f1-scaffold-infra` · **Deliverable:** `pnpm deploy:dev` brings up the whole empty stack on AWS.

**Instructions for Opus:**

1. Create the monorepo with pnpm workspaces following the tree in section 2 (all folders, even if some files stay as stubs). Strict `tsconfig.base.json`, minimal ESLint + Prettier, Node 20.
2. `packages/shared/src/protocol.ts`: define with **zod** the schemas for each client `action` (`message`, `history`, `channel`, `presign`, `typing`) and the TypeScript types for each server event (`message.new`, `history.page`, `channel.list`, `presign.result`, `error`). Export `Message`, `Channel`, `Attachment`. Limits: `text` max 4000 chars, `size` max 25 MB, channel `name` `^[a-z0-9-]{1,32}$`.
3. `packages/shared/src/ids.ts`: `GENERAL_CHANNEL_ID = "ch_general"`, `dmChannelId(a, b)` (sorts alphabetically), `isDmChannel(id)`, `newMessageSk()` → `${Date.now()}#${ulid()}`.
4. `infra/` with CDK v2 TypeScript. A single `SlackStack` parameterized by `stage` (`dev` | `prod`). Constructs:
   - **auth.ts**: `UserPool` with `selfSignUpEnabled: false`, email sign-in, password policy of at least 8 chars, `UserPoolClient` without a secret, auth flows `USER_SRP_AUTH` and `REFRESH_TOKEN_AUTH`. No advanced security.
   - **data.ts**: tables `slack-${stage}-messages` (PK `channelId` S, SK `sk` S), `slack-${stage}-connections` (PK `connectionId` S, TTL attr `ttl`), `slack-${stage}-channels` (PK `channelId` S). All `PAY_PER_REQUEST`, `RemovalPolicy.DESTROY` in dev and `RETAIN` in prod.
   - **storage.ts**: private `attachments` bucket, `blockPublicAccess: ALL`, CORS `PUT, GET` from `*` (restricted to the domain in F4), lifecycle → `GLACIER_INSTANT_RETRIEVAL` after 90 days. Private `web` bucket for the SPA.
   - **api.ts**: `WebSocketApi` with `routeSelectionExpression: "$request.body.action"`. One `NodejsFunction` per handler in `backend/src/handlers/*.ts` (ARM_64, 256 MB, NODEJS_20_X, `logRetention: ONE_WEEK`, env with table names, bucket and `WS_ENDPOINT`). REQUEST-type `WebSocketLambdaAuthorizer` on `$connect` with `identitySource: ["route.request.querystring.token"]`. Routes: `$connect`, `$disconnect`, `message`, `history`, `channel`, `presign`, `typing`. `prod` stage with auto-deploy. Permissions: `grantManageConnections` to message/channel; table read/write as needed; bucket `grantPut`/`grantRead` to presign.
   - **web.ts**: `Distribution` with an S3 origin via **OAC**, `PriceClass.PRICE_CLASS_100`, `defaultRootObject: index.html`, 403/404 errors → `/index.html` 200 (SPA routing), compression on. `BucketDeployment` that uploads `apps/web/dist` with a 1-year `cacheControl` for `/assets/*` and `no-cache` for `index.html`. (The custom domain and certificate are added in F4.)
   - **cost.ts**: `Tags.of(this).add("project","slack")`; monthly USD 5 `CfnBudget` with notifications to `carlos@mindfultech.ec` at 80 % and 100 % (`prod` only).
   - `CfnOutput` for: `UserPoolId`, `UserPoolClientId`, `WebSocketUrl`, `CloudFrontUrl`, `AttachmentsBucket`.
5. `backend/src/handlers/*.ts`: **stubs** that return `{statusCode: 200}` so the stack builds and deploys. The real logic is F2.
6. `infra/scripts/seed-general.ts`: conditional PutItem of `ch_general` (`name: "general"`, `type: "public"`). The `deploy:dev` / `deploy:prod` scripts run it after the deploy.
7. `.github/workflows/ci.yml`: on PR to `main` → `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`. Node 20, pnpm cache.
8. Initial `README.md`: prerequisites (Node 20, pnpm, AWS CLI with a profile), `pnpm install`, `pnpm deploy:dev`, how to create the two Cognito users from the console (`aws cognito-idp admin-create-user` + `admin-set-user-password --permanent`), how to copy the outputs into `apps/web/.env`.

**F1 acceptance criteria:**
- `pnpm install && pnpm lint` green.
- `pnpm deploy:dev` finishes without errors and prints the 5 outputs.
- `wscat -c "<WebSocketUrl>?token=garbage"` is rejected (401/403) — the authorizer stub must return **Deny** by default.
- The two Cognito users can be created with the commands from the README.
- `pnpm destroy:dev` tears everything down without leaving orphaned resources (check that the buckets have `autoDeleteObjects` in dev).

---

### PHASE 2 — Lambda handlers with real logic + unit tests

**Branch:** `feature/f2-backend-handlers` · **Deliverable:** complete backend tested against mocks; verifiable with `wscat` against the dev stack.

**Instructions for Opus:**

1. **`lib/`** in `backend/src`:
   - `ddb.ts`: singleton `DynamoDBDocumentClient`; table names from `process.env`.
   - `response.ts`: `ok()`, `badRequest()`, `reply(connectionId, event)` (uses `ApiGatewayManagementApiClient` with `endpoint = WS_ENDPOINT`).
   - `broadcast.ts`: `broadcast(event)` → Scan of `connections` (≤ 2 rows, a Scan is fine at this scale), `PostToConnection` in parallel with `Promise.allSettled`; on `GoneException` (410) it deletes the connection.
   - `s3.ts`: `presignPut(key, contentType, size)` and `presignGet(key)` with `@aws-sdk/s3-request-presigner`, `expiresIn: 300`.
   - `logger.ts`: `log.info/warn/error` as JSON; `debug` only if `LOG_LEVEL=debug`.
2. **`authorizer.ts`**: `CognitoJwtVerifier.create({ userPoolId, tokenUse: "id", clientId })` from `aws-jwt-verify`. Reads `event.queryStringParameters.token`. Returns an `Allow` policy with `context: { userId: sub, email }`; any error → `Deny`. Caches the verifier outside the handler.
3. **`connect.ts`**: reads `userId`/`email` from `event.requestContext.authorizer`, PutItem into `connections` with `ttl = now + 2h`.
4. **`disconnect.ts`**: DeleteItem from `connections`.
5. **`message.ts`**: parses `JSON.parse(event.body)` with the zod schema from `shared`; builds a `Message` with `messageId = ulid()`, `sk = newMessageSk()`, `userId`, `userEmail` (from the authorizer context stored in `connections` — do a GetItem of the connection to get `userId`/`email`), `createdAt`; PutItem into `messages`; `broadcast({ type: "message.new", message, clientId })`. If the `channelId` does not exist in `channels` → `CHANNEL_NOT_FOUND` error.
6. **`history.ts`**: Query `channelId = :c`, `ScanIndexForward: false`, `Limit: 50`, `ExclusiveStartKey` decoded from `cursor` (base64 of the LastEvaluatedKey). Replies `history.page { channelId, items (in ascending chronological order), nextCursor }` to the sender only.
7. **`channel.ts`**: `op: "list"` → Scan of `channels` filtering `archived <> true`, includes public channels and the DMs the `userId` takes part in; `op: "create"` → validates a unique name (a GetItem on `ch_<ulid>` does not work for name uniqueness: do a Scan and compare `name`, acceptable with < 50 channels), PutItem, broadcast `channel.list`; `op: "dm"` → conditional PutItem of `dm_<a>_<b>` with `type: "dm"`, `members: [a, b]`, broadcast `channel.list`.
8. **`presign.ts`**: `op: "put"` → validates `size ≤ 25 MB`, sanitizes `name` (only `[a-zA-Z0-9._-]`), key `attachments/${channelId}/${ulid()}-${name}`, replies `presign.result { url, key, requestId }`; `op: "get"` → validates that `key` starts with `attachments/`, replies with a GET URL.
9. **`typing.ts`**: returns 200, no broadcast (enabled in v0.2).
10. **Tests (Vitest + `aws-sdk-client-mock`)** in `backend/test/`: one file per handler. Cover: invalid payload → BAD_REQUEST error; `message` persists and broadcasts; `history` paginates and returns `nextCursor`; `channel.create` rejects a duplicate name; `dm` produces the same id regardless of order; `presign.put` rejects > 25 MB; `authorizer` denies an invalid token (mock `CognitoJwtVerifier`). Goal: every handler with at least one happy path and one error case.
11. Update `infra/lib/api.ts` if any handler needs extra permissions (e.g. `message` needs `GetItem` on `connections` and `channels`).

**F2 acceptance criteria:**
- `pnpm test` green, all handlers covered.
- Against the dev stack, with two terminals running `wscat -c "<url>?token=<real idToken>"`:
  - `{"action":"channel","op":"list"}` returns `#general`.
  - `{"action":"message","channelId":"ch_general","text":"hello","clientId":"x"}` in terminal A shows up as `message.new` in terminal B in < 1 s.
  - `{"action":"history","channelId":"ch_general"}` returns the message.
  - `{"action":"presign","op":"put",...}` returns a URL for which `curl -X PUT --upload-file photo.png "<url>"` responds 200.
- CloudWatch logs in JSON at INFO level, 7-day retention.

> To get a real `idToken` for testing: `aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH ...` (enable `USER_PASSWORD_AUTH` on the client in dev only) or a `backend/scripts/get-token.ts` script with `amazon-cognito-identity-js`.

---

### PHASE 3 — Web client (React + Vite): login, channels, real-time messages, history, attachments

**Branch:** `feature/f3-web-client` · **Deliverable:** the SPA works in `pnpm dev` against the dev stack and on the dev CloudFront.

**Instructions for Opus:**

1. **Setup**: Vite + React 18 + TypeScript + Tailwind. Dependencies: `aws-amplify` (only `aws-amplify/auth`), `zustand`, `react-router-dom`, `ulid`, `@mindfultech/shared` (workspace). Configure Amplify in `main.tsx` with `VITE_COGNITO_USER_POOL_ID` and `VITE_COGNITO_CLIENT_ID`.
2. **`lib/auth.ts`**: `signIn(email, password)`, `getIdToken()` (uses `fetchAuthSession`, which refreshes on its own), `signOut()`, `getCurrentUser()`. Protected route: no session → `/login`.
3. **`lib/ws.ts`** — `WsClient` class:
   - `connect()`: gets the idToken, opens `new WebSocket(`${VITE_WS_URL}?token=${token}`)`.
   - `send(action, payload)`: `JSON.stringify({ action, ...payload })`; if the socket is not open, it queues and sends on reconnect.
   - `on(type, handler)` for server events.
   - **Reconnection with exponential backoff** (1 s, 2 s, 4 s… max 30 s, with jitter) on `onclose`; never in a tight loop. On reconnect, it requests `channel.list` and the active channel's `history` again.
   - Heartbeat: none (API Gateway closes after 10 min of inactivity / 2 h max; reconnection covers it).
4. **`store/index.ts`** (zustand): `user`, `channels[]`, `activeChannelId`, `messagesByChannel: Record<id, Message[]>`, `cursors: Record<id, string|null>`, `lastReadTs: Record<id, number>` (persisted in localStorage), `unreadCount(id)` = messages with `createdAt > lastReadTs[id]` that are not mine. On receiving `message.new`: if it belongs to the active channel and the window has focus → mark as read; otherwise → increment unread.
5. **Components**:
   - `LoginPage`: email + password, Cognito errors shown in English, redirects to `/app/ch_general`.
   - `Sidebar`: "Channels" and "Direct messages" sections; each item with an unread badge; a "+" button opens a prompt to create a channel (`channel create`); the DM is created with `channel dm` towards the other user (user list: hardcode the two emails in `VITE_USERS` for now — it is a 2-person MVP). Highlights the active channel. Cmd/Ctrl+K: quick palette to jump between channels (filters by name).
   - `ChannelView`: header with `#name` or the DM's email; `MessageList`; `Composer`.
   - `MessageList`: requests `history` on mount; renders in ascending order; `IntersectionObserver` on the first element → if `cursors[id]` is not null, requests the next page and **preserves the scroll position** when prepending. When `message.new` arrives with the scroll at the bottom → auto-scroll; otherwise, shows a "↓ new messages" pill. Groups consecutive messages from the same author within < 5 min.
   - `MessageItem`: avatar = initial of the email, name (local part of the email), time `HH:mm`, text via `markdown.ts`, list of `Attachment`.
   - `Composer`: auto-height `textarea`; Enter sends, Shift+Enter inserts a newline; drag & drop and `onPaste` of images/files → `upload.ts`; shows chips for pending attachments with progress; disables sending while uploading. Sends `message` with `clientId = ulid()` and does an **optimistic insert** (`pending` state), reconciled when the `message.new` with the same `clientId` arrives.
   - `Attachment`: if `contentType` starts with `image/` → requests `presign get` and renders an `<img>` (max 320 px tall, click opens it in a new tab); otherwise → chip with name, size and a download button (requests `presign get` on click and opens the URL).
   - `markdown.ts`: `**bold**`, `_italic_`, `` `code` ``, ``` ``` blocks, URLs → `<a target=_blank rel=noopener>`. Escape HTML **before** applying the regexes (never `dangerouslySetInnerHTML` with unescaped text). Emoji: users type them with the OS keyboard; no picker is included.
6. **`lib/upload.ts`**: `uploadFile(file, channelId)` → validates 25 MB on the client → `presign put` → `fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type } })` → returns `Attachment { key, name, size, contentType }`.
7. **UI**: Slack-like style (dark sidebar, light message area), but without wasting time on pixel-perfection. Utility-first Tailwind, no component library.
8. **Build**: `pnpm --filter web build` produces `dist/` with hashed assets; `infra` deploys it.

**F3 acceptance criteria:**
- Login with each user; reloading the page keeps the session.
- Two browsers (Carlos / Rene): a message shows up in the other one in < 1 s.
- Scrolling up loads earlier pages without jumps.
- Dragging in a 5 MB image → it uploads and appears inline on both sides; a 20 MB PDF → downloadable chip; a 30 MB file → client-side error before uploading.
- Turning Wi-Fi off for 20 s and back on → reconnects on its own and recovers missed messages (via `history`).
- The unread badge goes up on inactive channels and clears when you open them.
- User without an account → Cognito rejects them, no socket is opened.

---

### PHASE 4 — Production: domains, certificate, deploy pipeline, final README → release v0.1.0

**Branch:** `feature/f4-prod-deploy` → `main` + tag `v0.1.0` · **Deliverable:** `https://slack.mindfultech.ec` working with `wss://ws.mindfultech.ec`.

**Instructions for Opus:**

1. **Certificate**: in `infra/lib/web.ts` and `api.ts`, for `stage === "prod"`, import an ACM certificate by ARN (`CERT_ARN` from CDK context). The certificate is created **by hand** in ACM `us-east-1` for `slack.mindfultech.ec` and `ws.mindfultech.ec` (a single cert with two SANs), DNS validation → Carlos creates the validation CNAMEs in Namecheap. Document the exact step in the README.
2. **CloudFront custom domain**: `domainNames: ["slack.mindfultech.ec"]`, `certificate`. Output `CloudFrontDomain`.
3. **API Gateway custom domain**: `DomainName` for `ws.mindfultech.ec` with the same cert, `ApiMapping` to the stage. Output `WsDomainTarget` (the `regionalDomainName`).
4. **DNS in Namecheap** (manual, Carlos): `slack` CNAME → `<dist>.cloudfront.net`; `ws` CNAME → `<regionalDomainName>`. Document it.
5. **Attachments bucket CORS**: restrict `allowedOrigins` to `https://slack.mindfultech.ec` in prod (and `http://localhost:5173` + the CloudFront domain in dev).
6. **`deploy.yml`**: on push to `main`: OIDC → `aws-actions/configure-aws-credentials` with the `GitHubDeployRole` role (create it in `infra/lib/cost.ts` or in a `ci.ts` construct: trust policy with `token.actions.githubusercontent.com`, condition `repo:crpozo/slack:ref:refs/heads/main`); `pnpm install`; `pnpm build` (web reads `.env.production` with the prod URLs); `pnpm deploy:prod`; the `BucketDeployment` already invalidates CloudFront (`distribution` + `distributionPaths: ["/*"]`).
7. **Minimal hardening**: `message` rejects empty `text` without attachments; `presign get` only if the `key` exists; `authorizer` logs the `sub` at INFO but never the token.
8. **Cost Anomaly Detection**: `CfnAnomalyMonitor` + `CfnAnomalySubscription` (email to Carlos) in `cost.ts`, prod only.
9. **Final README** with the sections: What it is · Architecture (link BLUEPRINT.md) · Prerequisites · First deploy (cert → CNAMEs → `deploy:prod` → create users) · Local development (`deploy:dev`, `.env`, `pnpm dev`, `destroy:dev`) · Git Flow · Tests · Costs and alerts · v0.2 roadmap (the right column of section 0).
10. Bump the version to `0.1.0` in every `package.json`. `CHANGELOG.md` with what is included.

**F4 acceptance criteria (= MVP acceptance criteria):**
- `https://slack.mindfultech.ec` loads with a green padlock; `wss://ws.mindfultech.ec` connects.
- A message reaches the other user in < 1 s from two different computers.
- Reloading shows the full history.
- A 25 MB attachment uploads, displays and downloads; accessing the object URL without a signature → 403.
- Connection without a JWT → rejected. Non-existent user → cannot get in.
- `git clone` + README are enough to bring up a dev stack from scratch.
- USD 5 budget and Anomaly Detection visible in the Billing console; every resource tagged `project=slack`.
- 30-min manual session between Carlos and Rene; failures logged as issues.
- Merge `feature/f4-prod-deploy` → `main`, tag `v0.1.0`, pipeline green.

---

### PHASE 5 — Feature expansion (v0.2.0)

> **Added on Oct 12**, with MVP v0.1.0 in production. It replaces the old "Phase 5 — Tauri", which becomes Phase 6. It moves these v0.2 items into the left column of section 0: **reactions**, **private channels**, **display names**, **dark mode**, **collapsible sidebar**, **emoji picker** and **voice/video calls (WebRTC)**.

**Business requirements**

1. **Voice and video calls**, P2P with WebRTC. The API Gateway WebSocket is used **for signaling only** (SDP offers/answers and ICE candidates): audio and video never go through AWS, so the extra cost is USD 0.
2. **UI/UX:** dark mode (Tailwind), resizable and collapsible sidebar (icons-only mode) and an emoji picker in the composer.
3. **Private channels:** new channels are **private by default**; whoever creates the channel invites specific members. Only members see the channel, its history and its attachments, and only they receive its messages.
4. **Emoji reactions** on individual messages.
5. **Display names:** each person sets a name in Settings, which becomes their main identifier in the UI (instead of the email or the Cognito `sub`).

It is carried out in three sub-phases, each on its own branch with its own PR to `main`:

#### 5.1 — Backend and data model

**Branch:** `feature/f5-1-backend` · **Deliverable:** protocol, handlers, tables and permissions ready and tested; the current UI keeps working the same.

1. **`slack-${stage}-users` table** (PK `userId` S; `email`, `displayName`, `createdAt`, `updatedAt`). A table was chosen over a Cognito attribute because every client reads the directory in real time with a single Scan, and the Lambda does not need Cognito admin permissions.
   - `$connect` upserts the row (email from the token; `displayName` defaults to the local part of the email, without overwriting an existing one). That way anyone who has signed in shows up in the directory, which **replaces `VITE_USERS`** for DMs and invitations.
   - New `user` action: `{ op: "list" }` → `user.list { users[] }` to the sender; `{ op: "update", displayName }` (1–40 characters, no control characters) → saves and broadcasts `user.updated { user }` to everyone.
   - Messages still store `userId`/`userEmail`; the name is resolved on the client from the directory, so a name change also shows up in the history.
2. **Private channels.** `type` becomes `public | private | dm`; `members: string[]` on `private` and `dm`.
   - `channel { op: "create", name, visibility? }`: `visibility` is `private` by default; the creator is a member. Names are unique across public and private channels.
   - `channel { op: "invite", channelId, userIds[] }`: only the channel's creator (`FORBIDDEN` otherwise), only private channels, and only users that exist in `users` (`USER_NOT_FOUND`). Broadcasts `channel.list`, filtered per person.
   - **Backend authorization:** `message`, `history`, `presign` and `react` load the channel and check access (public, or member). Without access, the response is `CHANNEL_NOT_FOUND`, without revealing that it exists. The fan-out of `message.new` and `message.reaction` goes only to members' connections. `channel.list` only includes public channels and those the user is a member of.
   - Existing public channels (including `#general`) stay public; no migration is needed.
3. **Reactions.** `reactions` on `messages` is a map of `emoji → string set of userIds`.
   - New `react { channelId, sk, emoji, op: "add" | "remove" }` action: atomic `ADD`/`DELETE` on the set, idempotent per person. Old messages without `reactions` are initialized on the fly.
   - Broadcasts `message.reaction { channelId, sk, messageId, reactions }` to members. `history.page` and `message.new` include `reactions` as `Record<emoji, userId[]>`.
   - Emoji: 1–16 characters with no spaces or control characters.
4. **New minimal permissions:**
   - `connect`: `UpdateItem` on `users`.
   - `user`: `Scan` and `UpdateItem` on `users`, plus broadcast.
   - `react`: `UpdateItem` on `messages` and `GetItem` on `channels`, plus broadcast.
   - `history` and `presign`: `GetItem` on `channels`.
   - `channel`: `UpdateItem` on `channels` and `BatchGetItem` on `users`.
5. **Tests:** `user` and `react` handlers; invitations (creator, `FORBIDDEN`, `USER_NOT_FOUND`); denied access to private channels in `message`, `history`, `presign` and `react`; fan-out to members only; user upsert in `$connect`; CDK assertions for the `users` table, the new routes and the permissions.

**5.1 acceptance criteria:** `pnpm lint` and `pnpm test` green; `cdk synth` with no replaced resources (only the `users` table, the `user`/`react` Lambdas and their routes are added); with `wscat`, a non-member neither receives a private channel's messages nor can read its history.

#### 5.2 — UI/UX

**Branch:** `feature/f5-2-ui`

1. **Dark mode:** `darkMode: "class"` in Tailwind. Light / Dark / System toggle in Settings, saved in localStorage, with light as the default theme. Dark tokens derived from the MindfulTech design system: surfaces in `ink` tones, light text and `primary`/`sky` as accents with AA contrast.
2. **Sidebar:** width resizable by dragging the edge (200–400 px, persisted) and collapsible to an icons-only mode (avatars/initials with badge). Tooltip with the name on hover. On mobile it is still the current drawer.
3. **Emoji picker** in the composer (inserts at the cursor) and for reacting. It must be a lightweight library loaded on demand (dynamic `import()`) so it does not bloat the initial bundle. It uses the English emojibase dataset (`emojibase-data/en/compact.json`) with the `en` locale, and search works in English.
4. **Reactions:** chips under each message (emoji + count, highlighted if I reacted), click to toggle and "+" for the picker.
5. **Settings:** modal with display name (`user update`) and theme. The whole UI shows `displayName` (email in a tooltip).
6. **Private channels:** when creating one you choose Public/Private (Private by default) and can invite people from the `user.list` directory; the creator sees "Invite" in the channel header. Padlock in the sidebar for private channels. DMs are opened from the directory, without `VITE_USERS`.
7. **Language:** the UI was translated to English ("Create channel", "Invite", "Typing…", etc.), with light as the default theme.

**5.2 acceptance criteria:** persistent theme with no flash on load; collapsed sidebar and width survive a reload; real-time reactions in both browsers; a private channel does not show up for a non-invited user until they are invited; the display name changes live in the other session.

#### 5.3 — WebRTC calls (P2P)

**Branch:** `feature/f5-3-webrtc`

1. **Signaling:** new `call { callId, channelId, to, signal: "offer" | "answer" | "ice_candidate" | "end" | "decline", … }` action (route `call`).
   - The Lambda only relays `call.offer | call.answer | call.ice_candidate | call.end | call.decline { callId, channelId, from, … }` to the `to` user's connections, and only between the two members of the DM named by `channelId` (checked from the DM id itself, no table read); it stores nothing. `answer`/`decline`/`end` also reach the sender's other tabs so they stop ringing. An offer that reaches nobody is answered with `call.end { reason: "unavailable" }`.
   - Limits: SDP of at most 20,000 characters (API Gateway frames cap at 32 KB), ICE candidates of at most 2 KB, all validated with zod.
2. **Media:** `RTCPeerConnection` with a free public STUN server (`stun:stun.l.google.com:19302`) and **no TURN**, because TURN would cost money. Documented limitation: behind symmetric NATs or on corporate networks the call may fail to connect. If needed, a self-hosted TURN will be evaluated in a v0.3. Both sides always negotiate one audio and one video transceiver, so turning the camera on in a voice call and screen sharing (`getDisplayMedia`) are `replaceTrack`s without renegotiation; a negotiated data channel carries mic/camera/screen state.
3. **UI:** voice and video call buttons in a DM's header; incoming-call card (accept/decline) with a synthesized ringtone; call view with remote video (large) and local preview (PIP), mute, camera on/off, screen share and hang up. 1:1 calls only; a second caller gets "busy".
4. **Devices:** Settings → Audio & Video lists microphones and cameras (`enumerateDevices`); the choice is saved in localStorage and requested as `deviceId: { exact }`, falling back to the default device if it was unplugged.
5. **Permissions:** only `ManageConnections` and `GetItem`/`Scan`/`DeleteItem` on `connections` for the `call` Lambda.

**5.3 acceptance criteria:** voice and video call between two browsers on different home networks; hanging up on one side closes the other; the AWS cost does not change (only signaling WebSocket messages).

#### 5.4 — Call polish

**Branch:** `feature/f5-4-call-polish`

1. **Call summary in the chat:** when a call that connected ends, one message is posted to the DM through the normal `message` action (so it is stored in history): `📞 Call ended • 05:23` or `📹 Video call ended • 12:45` (`h:mm:ss` from one hour on). Only the caller posts it, whoever hangs up or if the connection drops, so it never appears twice; declined, missed or cancelled calls post nothing.
2. **In-call device selection:** a chevron next to the mic and camera buttons lists the inputs (`enumerateDevices`, refreshed on `devicechange`). Picking one captures that exact device and swaps it in with `RTCRtpSender.replaceTrack()`, with no renegotiation; mute is kept, a shared screen stays on the wire until sharing stops, and the choice becomes the saved preference. With the camera off the choice is only saved.

3. **Camera preview in Settings:** below the Camera picker, a 16:9 mirrored, muted preview of the selected camera. Privacy: the camera is opened only while the preview is visible (IntersectionObserver + page visibility) and every track is stopped on close, scroll-away, tab hidden or camera change (a stream that resolves late is stopped on arrival). It starts by itself only with camera permission already granted; otherwise a "Show camera preview" button asks first.

**5.4 acceptance criteria:** one summary message in both chats whichever side hangs up; switching camera and microphone mid-call keeps the call up with no new offer signaled.

#### 5.5 — UX feedback

**Branch:** `feature/f5-5-ux-feedback`

1. **Heartbeat:** API Gateway drops WebSockets idle for 10 minutes. The client sends `{ "action": "ping" }` every 3 minutes while the socket is open (nothing while reconnecting); `ping` is its own route to a no-op Lambda (200, no reply, no table access, no permissions).
2. **New DM from the sidebar:** a `+` next to "Direct messages" opens a single-select people picker over the directory (`user.list`); picking someone opens the DM immediately.
3. **Discord-style call layout:** the call renders as an in-flow panel at the top of the DM's chat column (≈48 vh, capped), never a full-screen overlay: the sidebar and the composer stay usable. In other channels a slim "In a call with…" bar offers *Return to call* and *Hang up*; the peer's audio element is mounted globally so it keeps playing while browsing. Accepting a call navigates to its DM. The ringing card stays a fixed notification.
4. **Dual-track screen share:** three transceivers are negotiated in a fixed order, audio, camera, screen; the screen has its own `RTCRtpSender`, so sharing is `replaceTrack` on it and the camera is never replaced. Incoming tracks are told apart by m-line position (the `track` event fires inside `setRemoteDescription`, before the callee has mapped its senders). While a screen is shared it takes the stage and both cameras move to a strip on the right (a row below, on narrow screens). If both share, the remote screen takes the stage and yours becomes a tile. An older peer without the third transceiver gets "Screen sharing isn't available in this call."

**5.5 acceptance criteria:** a connection left idle for more than 10 minutes stays open; the `+` DM picker opens a DM with anyone in the directory; during a call the sidebar is clickable and a message can be sent from the composer; while sharing, both cameras are visible on both sides and no new offer is signaled.

#### 5.6 — Notification sounds

**Branch:** `feature/f5-6-sounds`

1. **Synthesis, zero cost:** all sounds are generated with the Web Audio API (oscillators + gain envelopes) in `apps/web/src/lib/sounds.ts`; no audio files, nothing in S3. One shared `AudioContext`, created lazily.
2. **Call rings:** the caller hears a soft 440/480 Hz ring every 3 s from the moment the offer is sent until the answer arrives; the callee hears an 880/660 Hz chime every 3 s while the incoming card is visible. Both stop at once on answer, decline, cancel, timeout (45 s / 50 s) or hang-up: every exit goes through `finish()` → `stopRinging()`.
3. **Message pop:** two short triangle notes on `message.new` when the message is from someone else and the user is not viewing that channel with the tab visible and focused (the same `isFocused` rule that marks messages as read).
4. **Autoplay policy:** every start goes through `unlock()` (`AudioContext.resume()` in a try/catch); a blocked context stays silent and the UI still shows the notification. `installAudioUnlock()` resumes the context on the first `pointerdown`/`keydown`, so rings and pops triggered later by network events can play. Each ring cycle re-checks the context, so nothing is queued on a suspended context (queued tones would all burst out on resume).
5. **Settings → Notifications:** a "Play notification sounds" switch (default on, `localStorage` key `slack.sounds`); turning it off stops a ring in progress and silences everything.

**5.6 acceptance criteria:** both ends ring from offer to answer and fall silent together; a message in another conversation pops and one in the open conversation does not; with sounds off nothing plays; a page the user has never interacted with shows the call card without errors.

**Phase 5 wrap-up:** `CHANGELOG.md` and versions bumped to `0.2.0`, README updated and tag `v0.2.0`.

---

### PHASE 6 — Task Manager (boards with members)

**Branch:** `feature/f6-task-manager`

1. **Data (two tables, on-demand):** `boards` with PK `boardId` + SK `sk`: the board row (`sk = "BOARD"`: `name`, `ownerId`, `members` as a string set that includes the owner, `createdAt`) is the single source of truth for access; one membership row per member (`sk = "MEMBER#<userId>"`, `userId`) feeds the `byUser` GSI so listing someone's boards is a query. `tasks` with PK `taskId` and the `byBoard` GSI (`boardId` → `createdAt`); fields `title`, `description`, `status` (`TODO | IN_PROGRESS | DONE`), `createdBy`, `createdAt`, `updatedAt`. Ids are `b_<ulid>` / `t_<ulid>`.
2. **API (API Gateway v2 HTTP API + JWT authorizer):** `GET /boards`, `POST /boards`, `POST /boards/{id}/members`, `GET /boards/{id}/tasks`, `POST /boards/{id}/tasks`, `PUT /tasks/{taskId}`, `DELETE /tasks/{taskId}`. The authorizer validates the Cognito id token (issuer = the user pool, audience = the web client), so no authorizer Lambda runs; one `tasks` Lambda serves every route and reads the caller from the JWT `sub`. CORS is limited to the app origins (CloudFront, custom domain, localhost). Bodies are validated with zod schemas in `packages/shared/src/tasks.ts`.
3. **Security:** every handler loads the board row and checks `ownerId === caller || members ∋ caller` before anything else; a board or task the caller may not see answers **404** (never 403, so nothing leaks). Adding members is owner-only (403 otherwise) and invitees must exist in the `users` directory. Creating a board and adding members write the board row and the membership rows in one `TransactWriteItems`. IAM: `GetItem/PutItem/UpdateItem/BatchGetItem/Query` on `boards`, `GetItem/PutItem/UpdateItem/DeleteItem/Query` on `tasks`, `BatchGetItem` on `users`, nothing else.
4. **Deploy:** `TasksApi` construct in `infra/lib/tasks-api.ts`, wired in `slack-stack.ts`; the URL is written to `config.json` (`tasksUrl`) and output as `TasksApiUrl`; `VITE_TASKS_URL` for `pnpm dev`.
5. **Frontend:** `APPS → Task Manager` in the sidebar; `/app/tasks[/:boardId]` renders `TaskManager` in place of the chat column (sidebar, settings, calls bar keep working). Board navigation on the left ("My boards" / "Shared with me"; a dropdown on phones), **Share board** (owner only) reusing the people picker, and a Kanban board with HTML5 drag and drop plus a "Move to…" menu for keyboard and touch. A zustand store (`store/tasks.ts`) applies every change optimistically and rolls it back with the server's message on failure.

#### 6.1 — Task details and real-time boards

**Branch:** `feature/f6-1-task-polish`

1. **Fields:** tasks gain `assigneeId` (a board member or `null`), `project` (≤ 40 chars, a free-text tag), `notes` (≤ 5000) and `attachments` (≤ 10 `{ key, name, size, contentType }`, the chat `Attachment` shape). Rows stored before these fields read back with defaults; no migration. `POST`/`PUT` validate that the assignee is on the board and that every attachment key starts with `attachments/<thisBoardId>/`.
2. **Attachments reuse the chat presign flow:** the `presign` WebSocket action now accepts a board id in `channelId`; `attachments/<boardId>/…` keys are gated by board membership for both PUT and GET, so download URLs (5-minute presigned GETs, fetched when a file is opened) never leak to non-members. The presign Lambda gains `GetItem` on `boards`.
3. **Real-time pushes without new infrastructure:** after each successful write the `tasks` Lambda scans the chat `connections` table, keeps the connections of the board's members, and posts `board.task_created | board.task_updated | board.task_deleted | board.updated` with `PostToConnection` (same `deliver()` as chat broadcasts, including 410 cleanup). The write completes before the push and the push never fails the request (logged instead). The Lambda gains `CONNECTIONS_TABLE`, `WS_ENDPOINT`, `Scan`/`DeleteItem` on `connections` and `execute-api:ManageConnections`.
4. **Client:** the chat controller forwards `board.*` events to the tasks store, which applies them idempotently (replace by id, append in creation order, drop on delete; `board.updated` adds/updates/removes the board for the current user). The actor's own echo and its HTTP response converge on one card. The Task Details modal (click a card) saves each field on blur/Enter (notes on blur), shows other members' edits live, offers status pills, an assignee dropdown of board members, a project input with the board's existing projects as suggestions, and attachments with drag-and-drop or file-picker upload, download and removal; it closes itself if the task is deleted elsewhere. Cards show the project tag (colour hashed from the name), the assignee's avatar and a paperclip with the attachment count.

5. **Rename:** `PUT /boards/{id} { name }` (owner only, 403 otherwise, 404 for non-members) with a conditional update on `ownerId`; pushed as `board.updated`. In the UI the owner clicks the board title to edit it in place (Enter/blur save, Escape cancels, optimistic with rollback).

**6.1 acceptance criteria:** a change by one member appears on another's open board within a second without a reload; a non-member cannot obtain a download URL for a board file; foreign attachment keys and non-member assignees are refused with 400; each detail field saves with its own `PUT`.

**Phase 6 acceptance criteria:** a non-member gets 404 from every board/task route and sees nothing in the UI; a member sees the board under "Shared with me" and can add/move/delete tasks but not share; dragging a card sends exactly one `PUT {status}` and survives a reload; a refused change is undone on screen.

### Phase 7 — Presence, deletion and Phase 6 cleanup

**Branch:** `feature/f7-presence-and-cleanup`

1. **Task Manager fixes:** the Kanban board is a 3-column grid spanning the whole chat area; the new-task title no longer re-focuses itself on every keystroke (which sent the first letters typed in the description, e.g. "te", into the title); Task Details is a `max-w-2xl` modal with a 14 rem Notes area and a blurred backdrop.
2. **Presence:** `$connect` sends `user.connected { userId }` to every other live connection (the new one can't receive until `$connect` returns); `$disconnect` deletes its row, does a *consistent* Scan of `connections` and sends `user.disconnected { userId }` only if that user has no other tab or device left. `user.list` carries an `online: string[]` snapshot. The sidebar's direct messages and the DM header show a green dot (online) or a hollow gray ring (offline). Both Lambdas gain `Scan`/`DeleteItem` on `connections` and `execute-api:ManageConnections`.
3. **Delete channels and DMs:** `{"action":"channel","op":"delete","channelId":…}` — a channel's creator (never `#general`) or either member of a DM. Messages are deleted first (Query + BatchWrite in 25s, retrying unprocessed items), then the row, then `channel.deleted { channelId, by }` goes to everyone who could see it. Clients drop it from the sidebar and whoever is viewing it is sent to `#general`. Attachments stay in S3 (lifecycle rules apply). The channel Lambda gains `DeleteItem` on `channels` and `Query`/`BatchWriteItem` on `messages`.
4. **Readable channel names:** `channel.create` takes the name as typed (1–40 chars, at least one letter or number) and stores it in `name`; uniqueness is checked on a derived `slug` (`slugifyChannelName`, in `packages/shared`), also stored. Rows from before keep working: their slug is derived from their (already slug-shaped) name.

**Phase 7 acceptance criteria:** closing one of two tabs keeps the user online for others, closing the last one turns their dot gray within a second; a deleted channel disappears from every member's sidebar without a reload and its viewers land on `#general`; "Web Design" shows as "Web Design" and "web design" is refused as a duplicate.

### Phase 8 — Web Push, mobile, legacy cleanup and board deletion

**Branch:** `feature/f8-mobile-and-push`

1. **VAPID keys at $0:** one SecureString parameter per stage, `/slack/<stage>/vapid` = `{ publicKey, privateKey, subject }`, created once with `pnpm --filter infra vapid <stage> [--subject mailto:…] [--rotate]` (Parameter Store standard tier, AWS-managed `aws/ssm` key; Secrets Manager would cost $0.40/month). CloudFormation can't create SecureStrings, and on purpose the stack doesn't reference the value at all: Lambdas get only `VAPID_PARAMETER` (the name) plus `ssm:GetParameter` on that one ARN, and decrypt it at cold start. The browser reads the public key from `GET /push/key`. A stage without the parameter deploys normally with push off (`/push/key` → 503, the UI says "not set up").
2. **Subscriptions:** table `slack-<stage>-push-subscriptions` (`userId` + `sk` = sha256(endpoint), one row per device). A `push` Lambda on the HTTP API serves `GET /push/key`, `POST /push/subscribe` and `DELETE /push/subscribe` behind the JWT authorizer; rows are keyed by the caller's own id. Endpoints must be https URLs of a known push service (FCM, Mozilla, Apple, WNS) — checked on save and again on send — so the message Lambda can't be pointed at arbitrary hosts.
3. **Sending:** after its broadcast the `message` Lambda computes recipients — the DM peer, or channel members `@mentioned` by display name (spaces removed) or email local part — drops anyone with a live connection, and sends `{ title, body (≤120-char preview), url, tag }` with `web-push` (TTL 1 h, high urgency, topic = conversation). Payloads are encrypted to the browser's keys. 404/410 deletes the subscription; nothing here can fail or delay the message.
4. **Client:** `public/sw.js` shows notifications (one per conversation) and on click focuses an open tab (which navigates itself) or opens one. Settings → *Push notifications* and a one-time *Enable* bar (permission prompts need a click). The subscription is re-synced on sign-in (re-subscribing after a key rotation) and dropped on sign-out. `manifest.webmanifest` + icons make the app installable (needed for push on iOS 16.4+). `sw.js` and the manifest are deployed `no-cache`.
5. **Mobile:** safe-area padding (`viewport-fit=cover`), `100dvh`, `interactive-widget=resizes-content`, 16px fields on phones (no iOS zoom), tap-to-react on messages, Kanban columns one per screen with snap scrolling.
6. **Legacy channels:** any member may delete a channel without `slug` (created before Phase 7), without `createdBy`, or whose creator isn't in the users directory (`canDeleteChannel` in `packages/shared`). `#general` stays protected.
7. **Delete boards:** `DELETE /boards/{id}` (owner only) deletes the tasks, then the membership rows, then the board row (conditional on `ownerId`), and pushes `board.deleted`. Web: gear menu next to the board title (Rename / Delete board), optimistic with rollback.

**Phase 8 acceptance criteria:** with the app closed, a DM or an `@mention` raises a system notification within seconds and clicking it opens the conversation; no push while the recipient has the app open; `cdk synth` output contains no VAPID key; the app is usable one-handed at 390 px wide; a pre-Phase-7 channel can be deleted by any member; deleting a board removes its tasks and moves every member off it.

### Phase 9 — Native gestures, voice messages, sturdier push, safer deletion

**Branch:** `feature/f9-native-gestures-and-audio`

1. **Gestures without a library** (`apps/web/src/lib/gestures.ts`): a pure classifier (10 px slop, dominant axis) and two hooks; mouse and pen keep hover and clicks. *Long press* (400 ms) opens a message's toolbar on touch — a tap no longer does (hover only on `(hover: hover)` devices, since iOS emulates hover on tap); the toolbar gains **Reply** and, on touch, **Copy text** (row text selection is off on touch). *Swipe right* on a message (rows are `touch-action: pan-y`) follows the finger up to 80 px and starts a reply past 60 px. *Edge swipe*: a touch within 24 px of the left edge drags the mobile drawer open; dragging it left closes it.
2. **Replies:** `message` takes an optional `replyTo { messageId, sk }`; the Lambda checks the original exists in the same channel and stores a `ReplySnapshot` (author, 140-char preview via the shared `replyPreview`, `hasAttachments`) so replies render without loading the original. Client: per-channel `replyTo` draft in the store, "Replying to Name: preview" banner (× / Esc), quote above the reply that scrolls to the original.
3. **Voice messages** (`lib/voice.ts`): `MediaRecorder` with `audio/mp4` (AAC, plays everywhere) when supported, else `audio/webm;codecs=opus`; red dot, timer, level meter, Cancel/Send; auto-send at 5 min, discard under 0.5 s; mic from Settings, released on send/cancel, disabled during calls. Uploaded through the existing presigned flow (bare content type, `voice-<date>.m4a`), with `durationMs` on the attachment. Played back with `<audio controls>` (URL refreshed once if expired). Push says "🎤 Voice message".
4. **Push registration** ("Registration failed - push service error"): one in-flight subscription at a time (sign-in sync and the Enable button raced); VAPID key trimmed and validated (65-byte P-256) before calling the push service; wait for an active service worker; `subscribe` retried 3× (1/3/8 s) clearing leftovers, never on a permission refusal, ending with an actionable message (incl. Brave's Google push setting); a failed silent sync is retried when the app becomes visible.
5. **Deletion and Ping:** no delete buttons in conversation headers any more. Each sidebar row has a ⋯ menu (hover with a mouse, always on touch): *Delete channel* (only for those allowed) or, for DMs, *Ping* and *Delete conversation*, confirmed by the existing modal. `nudge` WebSocket action + Lambda: a `user.nudge` toast/pop/buzz on the recipient's open tabs, or a Web Push when none is open; nothing stored; one per sender→recipient per minute (conditional write on the recipient's users row: `RATE_LIMITED`).

**Phase 9 acceptance criteria:** a tap on a message never opens the reaction bar but a long press does; swiping a message right shows the reply banner and the sent reply carries the quote; a left-edge swipe opens the drawer on a phone; a recorded voice note plays inline on iPhone and desktop; Ping reaches an open tab as a toast and a closed one as a notification; no delete control remains in any conversation header.

---

### Phase 10 — Polish and Tauri prep: swipe fix, push diagnostics, faster load, read receipts, typing, edits

**Branch:** `feature/f10-polish-and-tauri-prep`

1. **Edge swipe no longer taps `#general`** (`lib/gestures.ts`): after a horizontal touch drag the browser still synthesizes a `click` at the lift point (nothing scrolled, rows are `pan-y`), and the drawer had just slid under the finger. Fix: `swallowNextClick()` — a one-shot capture-phase `click` guard for 500 ms after the drag, shared by the edge swipe and the message swipe — plus `pointer-events-none` on the drawer while it is being dragged. Node-only unit tests with a bare `EventTarget` as `document`.
2. **iOS push diagnostics:** the service worker logs every step as `[sw]` (push received, notification shown, click, errors) and handles `pushsubscriptionchange` (re-subscribes with the same key and tells open tabs, which re-send it to the server); the app logs `[push]` breadcrumbs and shows the last failure under the Settings switch; the server logs each rejected push with the push service's status code, host and reply (a 403 from Apple is a VAPID mismatch, 410 an uninstalled app). The `tag` stays the channel/DM id (one notification per conversation, different chats stack); Pings use the DM id too.
3. **Initial load:** `index.html` starts the `/config.json` fetch before the bundle arrives (`window.__configRequest`); Task Manager, Settings and the quick switcher are `React.lazy`; vendor code (`react`, `aws-amplify`) in chunks of its own so app-only deploys don't invalidate them. The critical chunk went from 571 KB to 231 KB (+ cached vendor chunks). History for the open channel was already requested in parallel with the lists (frames queue until the socket opens).
4. **Calls:** two Google STUN servers; `[call]` console trace of ICE gathering/connection state, each local candidate's type, ICE errors and — once connected — the selected candidate pair (host/srflx/relay, RTT). Still no TURN: two peers both behind symmetric NAT (cellular) cannot connect, and the trace will show it.
5. **Read receipts as watermarks:** no per-message `readBy` in the table. The channel row carries `reads: { [userId]: { sk, at } }`; `read` (new WebSocket action + Lambda) moves the caller's mark forward with one conditional `UpdateItem` (creating the map on first use) and broadcasts `channel.read`. A message is read by someone iff their mark is ≥ its `sk` (sort keys order by time) — the shared `readBy()` derives the wire-level `Message.readBy` on the client. The client sends `read` only while focused, scrolled to the bottom, for the newest message when someone else wrote it and it is past the current mark; at most once per message. UI: "✓✓ Read" under your newest message in a DM.
6. **Typing:** the `typing` Lambda (a no-op since the MVP) now fans `user.typing` out to everyone else in the channel; the composer sends it at most every 3 s while there is text; the indicator above the composer expires 5 s after the last one and clears when that person's message arrives. Nothing stored.
7. **Edit messages:** `edit` WebSocket action + Lambda: conditional `UpdateItem` on the caller's own message (`userId = :me`, `ReturnValuesOnConditionCheckFailure` tells `FORBIDDEN` from `MESSAGE_NOT_FOUND`) sets `text`, `isEdited`, `editedAt` and broadcasts `message.updated`. Client: **Edit message** in the toolbar of your own messages, the composer switches to an "Editing message" banner with the old text (Enter saves, Esc cancels, ↑ in an empty composer edits your last message), "(edited)" next to the time.

**Phase 10 acceptance criteria:** an edge swipe on a phone opens the drawer and never changes the conversation; a push failure on a device is explained in Settings and in CloudWatch with the push service's answer; the first paint of a conversation ships ~230 KB of app code; the console traces ICE for every call; "Read" appears under your last DM message once the other person has it on screen; "Name is typing…" shows while they type; an edited message updates everywhere with "(edited)".

---

### Phase 11 — Task creation modal and louder notifications

**Branch:** `feature/f11-task-ui-and-sounds`

1. **"Add task" opens the full form** (`NewTaskModal`): the inline Title/Details box is gone; the button opens a modal with Title, Details, Project (with the board's suggestions), Assignee (board members), Notes and Attachments, and **Create** saves the fully formed task in one `POST /boards/{id}/tasks` (the API already accepted every field). Attachments are uploaded as they are added so they are ready on Create. The form pieces (`TaskForm.tsx`: status picker, project/assignee fields, uploads with drag-and-drop, attachment rows) are shared with the Task details modal, which keeps its save-as-you-go behavior. The store's `createTask(boardId, input)` takes the whole `CreateTaskInput`.
2. **Louder message sound:** `public/sounds/notify.wav` (two knocks and a bell, 0.75 s, peak-normalized to −0.2 dBFS; generated with numpy) played through one `<audio>` element at `volume = 1.0`; the synthesized pop stays as the fallback where the file can't play, itself much louder. Settings → "Play test" previews it even while sounds are off. Call rings are unchanged.
3. **Native tone for pushes:** the push payload carries `sound: "default"`, and the service worker shows every notification with `silent: false` plus a vibration pattern, so iOS plays its native alert tone instead of a silent banner. (Web Push has no sound field; the key is also there for a native wrapper that forwards the payload.)

**Phase 11 acceptance criteria:** "Add task" opens the New task modal with all fields and Create puts a task with assignee, project, notes and attachments on the board; a new message in another conversation is clearly audible on a laptop; an iPhone plays its default tone for a push.

---

### Phase 12 — Large attachments (500 MB)

**Branch:** `feature/f12-large-uploads`

Uploads already go straight to S3 with a presigned **PUT** whose signature pins `Content-Length` (the PUT equivalent of a POST policy's `content-length-range`): the size the server accepts in `presign` is the only size the object can have. So the change is the shared constant `MAX_ATTACHMENT_SIZE` (25 → 500 MB, enforced by the `presign` and `message` schemas), a separate `PRESIGN_PUT_EXPIRES_SECONDS` of 30 minutes for upload URLs (download URLs keep 5 minutes), the client check with "File must be under 500 MB.", and progress UI: "Uploading… n % of size" with a progress bar in the composer and in the task forms, Send disabled while any upload is in flight, Create reading "Uploading…". Nothing passes through API Gateway or Lambda, so no payload limits apply.

**Phase 12 acceptance criteria:** a 400 MB file attaches to a message and to a task, shows a live percentage while uploading, Send/Create stay disabled until it finishes, and a 501 MB file is refused with "File must be under 500 MB." before any request is made.

---

### PHASE 7 (optional) — Desktop app with Tauri

**Branch:** `feature/f7-tauri` (starts from `main` after v0.2.0).

**Instructions for Opus:**

1. `apps/desktop` with Tauri 2: a single window that loads `https://slack.mindfultech.ec` (config `app.windows[0].url`), size 1200×800, title "MindfulTech Slack". **No** second frontend.
2. Plugins: `tauri-plugin-notification` (native notification when `message.new` arrives and the window is not focused — the web frontend detects `window.__TAURI__` and uses it; if it does not exist, it uses the browser Notification API), `tauri-plugin-autostart`. System tray with "Open" and "Quit"; closing the window hides it instead of quitting.
3. `.github/workflows/desktop.yml`: on tag `v*`, `macos-latest` + `windows-latest` matrix, `tauri-apps/tauri-action` publishes the `.dmg` and `.msi` as release assets. No code signing for now (document the Gatekeeper/SmartScreen warning in the README).
4. Dock/taskbar badge and Cmd/Ctrl+F are left for v0.2.

**F7 acceptance criterion:** the release's `.dmg` and `.msi` open the app, show the login and receive a native notification with the window in the background.

---

## 5. Tomorrow's wrap-up checklist

- [ ] `main` = `v0.1.0`, protected, CI and deploy green
- [ ] A single `SlackProd` stack; `SlackDev` destroyed
- [ ] Two users created in Cognito, both have signed in from their own computer
- [ ] 30-min manual test done, issues opened with the `v0.2` label
- [ ] README verified by the person who did **not** write the code
- [ ] Carlos checks Cost Explorer filtered by `project=slack` (should show cents)
