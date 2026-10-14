# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Presence:** green dot for online, hollow gray ring for offline next to people under
  _Direct messages_ and in the DM header. Multiple tabs/devices count as one presence.
- **Delete channels and DMs** from the header (creator only for channels, never `#general`;
  either person for a DM). It disappears for every member in real time and whoever is viewing it
  is taken to `#general`.

- **Push notifications** for direct messages and `@mentions` while you're away (Web Push, no
  paid services): Settings → Push notifications, or the _Enable_ bar. Installable as an app on
  phones (needed for push on iPhone).
- **Delete boards** (owner): gear menu next to the board title; tasks are deleted with it.
- **Phones:** safe areas, no zoom on fields, swipeable Kanban columns, tap a message to react.

- **Voice messages:** tap the mic next to the composer, record (up to 5 min), send; they play
  right in the conversation.
- **Replies:** swipe a message right on a phone (or use Reply in its toolbar) to answer it; the
  quote shows above your message.
- **Phone gestures:** long-press a message for reactions (a tap no longer opens them) and swipe
  in from the left edge to open the sidebar.
- **Ping** someone from the ⋯ menu next to their name: a toast if they're online, a notification
  if not.

- **Read receipts:** "✓✓ Read" under your latest message in a direct message once the other
  person has seen it (one read mark per conversation, never stored per message).
- **Typing indicator:** "Name is typing…" above the composer.
- **Edit messages:** _Edit message_ in a message's toolbar (your own), or ↑ in an empty composer
  to edit your last one; edited messages show "(edited)".

- **New task modal:** _Add task_ opens the full form — title, details, project, assignee, notes and
  attachments — and _Create_ saves it all at once.
- **Settings → "Play test"** to hear the notification sound.

### Changed

- **Attachments up to 500 MB** (was 25 MB) in messages and tasks, for videos and datasets; the
  upload URL stays valid for 30 minutes and the UI shows "Uploading… n %" with a progress bar
  while the Send / Create button waits for uploads to finish.
- Deleting a channel or a conversation moved from the header to the ⋯ menu in the sidebar, to
  avoid accidental deletions.
- Faster first load: the config request starts before the app code arrives, Task Manager,
  Settings and the quick switcher load on first use, and vendor code is cached across deploys.
- Calls use two STUN servers and print an ICE trace in the console (`[call]`) for debugging.
- Push: the service worker and the app log every step (`[sw]`, `[push]`), Settings shows why the
  last attempt failed, and the server logs the push service's answer for each rejected push.

### Fixed

- Notification sound is much louder: a knock-and-bell at full volume instead of the quiet pop, and
  pushes ask the phone for its native alert tone (`sound: "default"`) instead of a silent banner.
- Swiping in from the left edge on a phone no longer opens `#general` (the drawer slid under the
  finger and caught the tap).
- iPhones whose push subscription was rotated by Apple get notifications again (the service
  worker re-subscribes and the app re-sends it).
- "Registration failed - push service error" when enabling notifications: subscriptions no
  longer race, the server key is validated first and temporary push-service failures are retried.
- Old test channels (created before readable names, or without a known creator) can be deleted
  by any member. `#general` stays protected.
- Task Manager board now fills the whole chat area with three equal columns.
- Typing a new task's description no longer sends its first letters (the stray "te") into the
  title.
- Task Details modal is wider (`max-w-2xl`) with a larger Notes field.
- New channels keep the name as typed ("Web Design") instead of the slug ("web-design").

## [0.1.0] — 2026-10-09

First release (MVP): an internal Slack for two people, serverless on AWS `us-east-1`.

### Added

- **Authentication:** Cognito login (email + password, SRP), persistent session, no
  self-sign-up. WebSocket authorizer that validates the id token and denies by default.
- **Channels:** `#general` by default, creating public channels, 1:1 DMs (private to their two
  participants) and a `Ctrl/⌘ + K` palette to jump between channels.
- **Real-time messaging** over API Gateway WebSocket (< 1 s), optimistic sending with retry,
  basic formatting (bold, italic, code, code blocks and links).
- **History** paginated backwards with infinite scroll that keeps the scroll position.
- **Attachments** up to 25 MB with S3 presigned URLs (PUT with signed type and size, GET only
  if the file exists), inline images and download for everything else.
- **Unread:** badge per channel and a total in the tab title.
- **Reconnection** with exponential backoff and recovery of missed messages.
- **UI** in React + Vite + Tailwind with the MindfulTech design system, responsive.
- **CDK infrastructure:** `SlackDev` and `SlackProd` stacks; Node 22 ARM Lambdas with least
  privilege; on-demand DynamoDB; web app on private S3 + CloudFront (OAC, HTTPS, security
  headers) built by `cdk deploy`, with `config.json` generated on every deploy.
- **Custom domains** (optional: `slack.mindfultech.ec`, `ws.mindfultech.ec`) with an existing
  ACM certificate and optional Route 53 records.
- **CORS** for attachments limited to the app origins and `localhost`.
- **Costs:** `project=slack` tag, a USD 5/month Budget and Cost Anomaly Detection with email
  alerts.
- **CI/CD:** lint + tests on every PR; `SlackProd` deploy on every push to `main` via GitHub
  OIDC (no access keys).

[0.1.0]: https://github.com/crpozo/slack/releases/tag/v0.1.0
