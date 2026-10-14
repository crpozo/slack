# slack

MindfulTech's internal Slack: real-time channels, DMs and attachments on AWS serverless
(Cognito + API Gateway WebSocket + Lambda + DynamoDB + S3 + CloudFront).

The full plan, the architecture and the MVP scope are in [BLUEPRINT.md](./BLUEPRINT.md).

> **Version 0.1.0 (MVP).** Changes in [CHANGELOG.md](./CHANGELOG.md).

## Structure

```
apps/web          React + Vite + Tailwind SPA (MindfulTech design system)
packages/shared   WebSocket protocol contract (zod) + id helpers
backend           Lambda handlers (Node 22) + Vitest tests
infra             AWS CDK v2: SlackDev and SlackProd stacks
```

## Prerequisites

- Node 22 (`nvm use` reads `.nvmrc`)
- pnpm 10 (`corepack enable`)
- AWS CLI v2 with a profile configured for the target account, region `us-east-1`
  (`export AWS_PROFILE=<profile>`)

## Getting started

```bash
pnpm install
pnpm lint      # ESLint + typecheck + Prettier
pnpm test      # Vitest (shared + backend)
```

### First deploy to dev

```bash
pnpm bootstrap     # only the first time per account/region (cdk bootstrap)
pnpm deploy:dev    # build web → cdk deploy SlackDev → seed #general
```

`cdk deploy` builds `apps/web` (Vite) during synth, uploads `dist/` to the private bucket and
serves it through CloudFront (HTTPS, OAC, security headers, SPA routes). Hashed assets are
cached for 1 year; `index.html` and `config.json` never are, and every deploy invalidates
CloudFront.

The web app has no URLs or Cognito ids compiled in: CDK writes `/config.json` with the
`WebSocketUrl`, `UserPoolId` and `UserPoolClientId` of **that** stack, and the SPA reads it on
startup (under `pnpm dev` it doesn't exist and the `VITE_*` values from `apps/web/.env` are used
instead). The list of people for DMs comes from `VITE_USERS` in your local `.env`, or from the
`WEB_USERS` variable when deploying (`WEB_USERS="a@x.ec=sub,b@x.ec=sub" pnpm deploy:dev`).

When it finishes, CDK prints the outputs: `UserPoolId`, `UserPoolClientId`, `WebSocketUrl`,
`TasksApiUrl` (the Task Manager HTTP API), `CloudFrontUrl` (the published app) and
`AttachmentsBucket`. To see them again:

```bash
aws cloudformation describe-stacks --stack-name SlackDev \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
```

### Create the Cognito users

Public sign-up is disabled: users are created by hand. Repeat for each person (password of at
least 8 characters):

```bash
POOL_ID=<UserPoolId>
EMAIL=<email>

aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --password '<password>' \
  --permanent
```

### Configure and run the web app

```bash
cp apps/web/.env.example apps/web/.env
```

| Variable                    | Value                               |
| --------------------------- | ----------------------------------- |
| `VITE_WS_URL`               | `WebSocketUrl` output               |
| `VITE_COGNITO_USER_POOL_ID` | `UserPoolId` output                 |
| `VITE_COGNITO_CLIENT_ID`    | `UserPoolClientId` output           |
| `VITE_TASKS_URL`            | `TasksApiUrl` output                |
| `VITE_USERS`                | optional: `email=sub,…` (see below) |

Since Phase 5.1 the people directory comes from the backend (everyone who has signed in at
least once), so `VITE_USERS` is no longer needed. It only serves to list someone in the DMs who
has never signed in yet.

```bash
pnpm dev     # http://localhost:5173
```

The UI:

- **Session:** login with email and password; the session persists across reloads.
- **Sidebar:** channels (🔒 for private ones) and DMs with an unread badge. Widen it by dragging
  its edge and collapse it to icons only with the header button or `Ctrl/⌘ + B`; both are
  remembered. On mobile it is a slide-out menu.
- **Direct messages:** the `+` next to "Direct messages" opens a people picker; choosing someone
  opens the DM right away.
- **Channels:** `+` opens "Create channel", with Public/Private (private by default) and
  invitations from the directory. Whoever creates a private channel sees "Invite" in its header.
- **Messages:** Enter sends and Shift + Enter adds a new line. Files up to 500 MB can be
  attached, pasted or dropped, and emoji inserted with the composer's 🙂 button.
- **Reactions:** hovering over a message shows quick reactions and the full picker (with
  search). The chips under the message show the count; a click adds or removes yours.
- **Settings** (click your name, bottom left): display name, which everyone else sees live, and
  the Light / Dark / System theme (light by default).
- **Calls (DMs only):** the 📞 and 🎥 buttons in a DM's header start a voice or video call.
  The other person gets a ringing card (Accept / Decline). The call shows as a panel above the
  messages of that DM, Discord-style, so the sidebar and the composer stay usable; in other
  channels a slim "In a call with…" bar keeps the audio going and takes you back. Controls:
  mic, camera, screen share and hang up. Screen sharing sends the screen as a second video
  track, so both people's cameras stay visible in a strip next to the shared screen. Calls are peer-to-peer WebRTC: the WebSocket only
  relays the signaling (`call` route), audio and video never go through AWS. There is a public
  STUN server but no TURN relay, so a call may fail to connect behind strict corporate or
  symmetric NATs. The chevrons next to the mic and camera buttons switch devices mid-call
  without dropping it. When a connected call ends, the caller's app posts one message to the DM,
  e.g. `📹 Video call ended • 12:45`.
- **Sounds:** a soft ring while you call someone, a chime while a call comes in, and a short
  pop for a new message in a conversation you aren't looking at (never for your own messages).
  They are synthesized in the browser with Web Audio, so there is nothing to download. Browsers
  block audio until you have clicked or typed on the page once; until then the visual
  notifications still show. **Settings → Notifications** turns the sounds off.
- **Settings → Audio & Video:** pick the microphone and camera calls use (saved per browser),
  with a live, mirrored preview of the camera. The camera only runs while the preview is on
  screen: it is released as soon as the modal closes, the section scrolls away or the tab is
  hidden, and it never starts on its own unless camera access was already granted.
- `Ctrl/⌘ + K` opens the switcher to jump to a channel or person.
- **Apps → Task Manager:** Kanban boards (To Do / In Progress / Done) that replace the chat
  column. Create boards, drag cards between columns (or use each card's "Move to…" menu), add and
  delete tasks; every change shows at once and is rolled back with a message if the server
  refuses it. A board is private to its owner until they **Share board** with people from the
  directory; members see it under "Shared with me" and can edit its tasks. The owner can click the
  board's name to rename it. Click a card for its
  details: title, project tag, assignee (a board member), notes and attachments, each saved as
  you go. Attachments upload straight to S3 through the same presigned URLs as chat files, keyed
  under the board so only its members can download them. Every change is pushed to the other
  members over the chat WebSocket, so open boards update without a reload. The data lives in
  two DynamoDB tables behind an HTTP API (API Gateway v2) that validates the Cognito id token
  itself; the Lambda only serves boards whose owner or member list includes the caller.

### Test the WebSocket with `wscat`

Without a valid token the connection is rejected:

```bash
npx wscat -c "<WebSocketUrl>?token=garbage"  # → 403 (Deny)
npx wscat -c "<WebSocketUrl>"                # → 401 (no token)
```

With a real id token (the dev client accepts `USER_PASSWORD_AUTH` only for this):

```bash
TOKEN=$(aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id <UserPoolClientId> \
  --auth-parameters USERNAME=<email>,PASSWORD='<password>' \
  --query AuthenticationResult.IdToken --output text)

npx wscat -c "<WebSocketUrl>?token=$TOKEN"
```

Test messages (open two terminals to see the broadcast):

```json
{"action":"channel","op":"list"}
{"action":"message","channelId":"ch_general","text":"hello","clientId":"x"}
{"action":"history","channelId":"ch_general"}
{"action":"presign","op":"put","requestId":"r1","channelId":"ch_general","name":"photo.png","contentType":"image/png","size":12345}
{"action":"channel","op":"create","name":"Web Design","visibility":"public"}
{"action":"channel","op":"delete","channelId":"<channelId>"}
{"action":"user","op":"list"}
```

Push subscriptions use the HTTP API (`TasksApiUrl`) with the id token as a bearer:
`GET /push/key`, `POST /push/subscribe {"subscription": …}`, `DELETE /push/subscribe {"endpoint": …}`.

Connecting or closing the last connection of a user pushes `user.connected` /
`user.disconnected` to everyone else; `user.list` includes an `online` snapshot.

To upload with the presigned URL, `Content-Type` and the size must match what was requested:
`curl -X PUT -H "Content-Type: image/png" --upload-file photo.png "<url>"`. An unknown `action`
responds with `{"type":"error","code":"BAD_REQUEST"}` (`$default` route).

### Destroy dev

Every work session ends with:

```bash
pnpm destroy:dev
```

In dev, tables, the user pool, buckets (with `autoDeleteObjects`) and log groups are deleted with
the stack (`destroy:dev` doesn't build the web app: it passes `-c skipWebBuild=true`). In prod
(`SlackProd`) everything is kept (`RETAIN`) and the stack has termination protection.

## Production

### 1. Certificate and DNS (by hand, once)

1. In **ACM `us-east-1`**, request a public certificate for `slack.mindfultech.ec` and
   `ws.mindfultech.ec` (one certificate, two names) with DNS validation.
2. In Namecheap, create the validation CNAMEs that ACM shows and wait for the _Issued_ status.

### 2. First deploy

The prod certificate is committed in `infra/cdk.json` (`"prod": { "certificateArn": "…" }`; an
ARN is not a secret). Every `SlackProd` deploy — from any laptop or from CI — therefore keeps
CloudFront on `slack.mindfultech.ec` and the WebSocket on `wss://ws.mindfultech.ec`, with no
environment variable to forget. (A deploy without it falls back to the `*.cloudfront.net` and
execute-api hostnames, and the custom domain then answers with CloudFront's 403 page.)

```bash
export WEB_USERS="person1@mindfultech.ec=<sub>,person2@mindfultech.ec=<sub>"
pnpm deploy:prod
```

To use another certificate, change `infra/cdk.json`; `-c certificateArn=…` or `CERT_ARN` override
it for a single deploy. Dev never picks up prod's certificate.

| Context (`-c`)          | Environment variable       | Purpose                                        |
| ----------------------- | -------------------------- | ---------------------------------------------- |
| `certificateArn`        | `CERT_ARN`                 | Overrides `prod.certificateArn` in cdk.json    |
| `appDomain`             | `SLACK_APP_DOMAIN`         | Defaults to `slack.mindfultech.ec` in prod     |
| `wsDomain`              | `SLACK_WS_DOMAIN`          | Defaults to `ws.mindfultech.ec` in prod        |
| `hostedZoneId`          | `HOSTED_ZONE_ID`           | Creates Route 53 aliases (if the DNS is there) |
| `hostedZoneName`        | `HOSTED_ZONE_NAME`         | Defaults to the parent domain                  |
| `webUsers`              | `WEB_USERS`                | DM directory in `config.json`                  |
| `githubOidcProviderArn` | `GITHUB_OIDC_PROVIDER_ARN` | Reuse an existing GitHub OIDC provider         |

### 3. App DNS

With the DNS on Namecheap, create two CNAMEs with the deploy outputs:

- `slack` → `AppDnsTarget` (`<id>.cloudfront.net`)
- `ws` → `WsDnsTarget` (`d-<id>.execute-api.us-east-1.amazonaws.com`)

If the domain were on Route 53, pass `HOSTED_ZONE_ID` and CDK creates the records.

### 4. Users

Create the two accounts with the commands in [Create the Cognito users](#create-the-cognito-users)
using the `UserPoolId` of `SlackProd`.

### Moving data from dev to prod

If the team started out on `SlackDev`, `pnpm --filter infra migrate-dev-to-prod` copies accounts,
channels, DMs, messages, reactions, boards, tasks and attachments to `SlackProd`. Prod's user pool
gives everyone a new user id, so every id in the data (DM ids, members, reactions, board owners,
attachment paths of DMs…) is rewritten; Cognito can't export passwords, so the script asks for a
new one per person (it can be the same as before).

```bash
pnpm --filter infra migrate-dev-to-prod           # dry run: reads, reports, writes nothing
pnpm --filter infra migrate-dev-to-prod --apply   # migrate
```

To leave test accounts behind, delete them from the `SlackDev` user pool before running it:
anyone without an account there is left out together with their DMs (call summaries included),
messages, files, boards and tasks, and removed from member lists, reactions and assignments. The
dry run lists who is left out.

`SlackDev` is only read, never modified. Running it again later only brings over what changed
(accounts are reused, rows overwritten with the same content, copied files skipped). Keep
`SlackDev` until you have checked prod; don't run `pnpm destroy:dev` before.

### 5. Push notifications (VAPID keys, once per stage)

Web Push needs a VAPID key pair. It is stored encrypted in Parameter Store (free tier) and never
in CloudFormation, git or CI:

```bash
pnpm --filter infra vapid prod --subject mailto:ops@mindfultech.ec   # and/or: vapid dev
```

The Lambdas read `/slack/<stage>/vapid` at runtime, so this can run before or after a deploy;
until it exists, push is simply off. `--rotate` replaces the keys (browsers re-subscribe on their
next visit). On iPhone/iPad, push works only after _Share → Add to Home Screen_ (iOS 16.4+).

### 6. Continuous deployment (GitHub Actions)

`.github/workflows/deploy.yml` deploys `SlackProd` on every push to `main` (lint + tests →
`pnpm deploy:prod`). It authenticates via **OIDC** with the `slack-github-deploy` role that the
stack itself creates, with no access keys in GitHub; the role can only assume the CDK bootstrap
roles and seed `#general`, and only from `main` of `crpozo/slack`.

After the first manual deploy, in _Settings → Secrets and variables → Actions → Variables_:

- `AWS_DEPLOY_ROLE_ARN` = `GitHubDeployRoleArn` output (without this variable the workflow
  doesn't run)
- `WEB_USERS` and, if applicable, `HOSTED_ZONE_ID` and `GITHUB_OIDC_PROVIDER_ARN` (`CERT_ARN` is
  no longer needed: the certificate comes from `infra/cdk.json`)

If the account already had a GitHub OIDC provider, the first `deploy:prod` fails to create it:
retry with `GITHUB_OIDC_PROVIDER_ARN=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`.

Since every merge to `main` reaches production, test each change on `SlackDev` before approving
the PR.

The web app sends a `ping` frame every 3 minutes while connected, because API Gateway closes
WebSockets that stay idle for 10 minutes; the `ping` route is a no-op Lambda.

## Scripts

| Script             | What it does                                           |
| ------------------ | ------------------------------------------------------ |
| `pnpm dev`         | Vite dev server for the web app                        |
| `pnpm build`       | Builds all packages                                    |
| `pnpm lint`        | ESLint + `tsc --noEmit` + Prettier across the monorepo |
| `pnpm test`        | Unit tests                                             |
| `pnpm deploy:dev`  | Web build + deploy `SlackDev` + seed `#general`        |
| `pnpm deploy:prod` | Web build + deploy `SlackProd` + seed `#general`       |
| `pnpm destroy:dev` | Destroys `SlackDev`                                    |

## Branching

`feature/*` (or `fix/*`) branches off `main` and returns to `main` through a PR with squash
merge; there is no `develop`. Conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`,
`infra:`). CI (`pnpm lint` + `pnpm test`) runs on every PR to `main`. Details in section 3 of
[BLUEPRINT.md](./BLUEPRINT.md).

Versions are annotated tags on `main` with their entry in `CHANGELOG.md`:

```bash
git checkout main && git pull
git tag -a v0.1.0 -m "v0.1.0 — MVP"
git push origin v0.1.0
```

## Costs and alerts

All resources carry the `project=slack` tag. `SlackProd` creates:

- an **AWS Budget** of USD 5/month with email alerts at 80% and 100%;
- **Cost Anomaly Detection**: a monitor on the `project=slack` tag and a daily email summary
  when an anomaly totals ≥ USD 1.

Both notify the email in the `budgetEmail` context key (in `infra/cdk.json` or with
`-c budgetEmail=…`). It is required: without it `SlackProd` doesn't synthesize.
For the monitor to see the spend, activate the tag once in _Billing → Cost allocation tags_
(`project`); AWS takes up to 24 h to apply it.

## Roadmap

Threads · rename and archive channels · edit and delete messages · search ·
"typing…" · system notifications and `@` mentions · TURN relay for calls · desktop app (Tauri) ·
integration and E2E tests · AI agent with Bedrock.
