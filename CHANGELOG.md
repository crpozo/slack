# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Changed

- **Faster images.** Messages arrive with their download URLs already attached (`history.page`
  and `message.new`), so a page with twenty pictures no longer makes twenty `presign` round
  trips. URLs are signed per 2-hour window and stay valid for 3, and uploads are stored with
  `Cache-Control: private, max-age=31536000, immutable`, so the browser keeps serving an image
  it already has instead of re-downloading it under a fresh signature. Image uploads also get a
  downscaled copy (≤ 1280 px, WebP or JPEG, made in the browser) that the conversation shows at
  its known size, with the original one click away in the viewer and the Download button.
- **Lighter conversations.** The message list is virtualized (`@tanstack/react-virtual`): only
  the rows near the viewport exist in the DOM however long the session runs, scrolling up to
  load older pages keeps the viewport still, and a directory refresh no longer re-renders every
  message.

### Added

- **Calendar** (Apps → Calendar): a shared company calendar with month, week and day views.
  Meetings with invitees (only participants see them; invitees are notified), **vacation
  requests** charged in working days against a yearly allowance of 15 (admins can adjust it),
  an **admin approval queue** (pending → approved / rejected, days released on rejection or
  cancellation) and **national holidays** added by admins on everyone's calendar. New `events`
  and `vacation-balances` DynamoDB tables and `/calendar/*` routes on the HTTP API.
- **Project channels:** "Mark this channel as a Project" when creating or editing a channel, linking
  one of your Kanban boards or creating a new one named after the channel (created together with
  the channel, never one without the other). Project channels show a **📊 Board** shortcut in the
  header that opens the board, and a board icon in the sidebar.

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

- **Read receipts:** "✓✓ Read" under your latest message in a direct message once the other
  person has seen it (one read mark per conversation, never stored per message).
- **Typing indicator:** "Name is typing…" above the composer.
- **Edit messages:** _Edit message_ in a message's toolbar (your own), or ↑ in an empty composer
  to edit your last one; edited messages show "(edited)".

- **New task modal:** _Add task_ opens the full form — title, details, project, assignee, notes and
  attachments — and _Create_ saves it all at once.
- **Settings → "Play test"** to hear the notification sound.
- **Desktop app** for Windows and macOS (Tauri, `apps/desktop`): the production site in a native
  window with native notifications for DMs and `@mentions`, camera and microphone for calls and
  voice messages. Installers are built by GitHub Actions (_Actions → Desktop_) and attached to a
  GitHub Release.

- **Notification bell** at the top of the sidebar with a red unread count: recent DMs,
  `@mentions`, pings and board activity; a click opens the conversation or board.
- **Board notifications:** members hear about a new task and about a task moving to another column
  (in the bell, with the sound, as a desktop notification and as a push when they're away).
- **Notification volume** slider in Settings (0–100 %); moving it plays the sound at that level.

- **Guest access to boards:** invite external clients to a Kanban board by email (_Share →
  Invite by email_). They get a temporary password by email, choose their own on first sign-in,
  and see only the boards they're invited to: no channels, DMs, calls or settings, enforced by
  the server. New `admins` group: admins may rename any channel.
- **Floating call window:** leave the call's DM and the call keeps going in a small window over
  the app (video or avatar, your camera, timer, mute, camera, back to call, hang up). Drag it
  anywhere; it snaps to a corner and remembers it. Pop the video out with picture-in-picture
  where supported.
- **Read receipts in channels:** "Seen by Ana, Luis and 3 others" with avatars under the newest
  message.
- **Rename channels** from the ⋯ menu (creator or admin; links and history stay).
- **Pin chats:** _Pin chat_ in a DM's ⋯ menu keeps it at the top of Direct messages, with a pin;
  pins follow you across devices.

- **Secret messages** for passwords and API keys: the 🔒 button in the composer (or `/secret `
  at the start of the message) sends the text masked as `••••••••`; readers press the eye to
  reveal it on their screen, and Copy copies it. DynamoDB deletes the message exactly 7 days
  after it was sent (TTL on `expiresAt`); notifications, pushes and reply quotes only ever say
  "🔒 Secret". A secret can't be edited and can't carry files.
- **PDF viewer:** PDFs open in a large in-app window (the browser's own PDF viewer in a frame)
  instead of jumping to the S3 link, with Download and "New tab" for iPhones, which show only the
  first page in a frame.
- **Image viewer:** clicking an image opens it full screen inside the app (no more jumping to the
  raw S3 link): zoom with the wheel, a pinch or double-click / double-tap, drag to pan, Esc or a
  tap beside the picture to close, and a Download button.
- **Edit channel:** the ⋯ menu's _Edit channel_ (creator or admin) sets the name, a **topic**
  shown under the name in the header and a **description**. Click the channel name in the header
  to read them. `#general`'s topic and description are admin-only; its name stays.
- **Task archiving:** tasks done for more than a week are archived (never deleted) by a daily
  job and drop off the board; _Show archived (N)_ in the Done column's header brings them back
  into view. Moving a task out of Done unarchives it.

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

- **App logo pipeline:** `pnpm --filter web icons` turns `apps/web/public/logo.webp` into every
  icon (PWA, Apple touch, favicon, in-app logo, notification badge, desktop app) with
  cache-busting URLs. The in-app logo is now an image.

- **Unread badges** show the number of unread messages (99+ at most): red for DMs and channels
  where you were `@mentioned`, blue for other channels. The count comes from your read mark on the
  server, so it is the same on every device, survives reloads, and counts messages that weren't
  loaded yet. Replying in a conversation also marks the messages before yours as read.

### Removed

- **Ping** (the "look at me" nudge from a DM's ⋯ menu), with its `nudge` route and Lambda.

### Fixed

- **Retrying a failed message sent it twice.** The offline queue kept both the original and
  the retry, and a message that had reached the server (but whose confirmation was lost) was
  stored again. Retries now replace the queued copy, only run from the failed state, and the
  server recognizes a resent message by its client id and confirms the stored one instead.

- **Swiping the drawer open on a phone no longer jumps to `#general`:** the lift no longer becomes
  a click on the drawer's first row, and iPhone Safari's own "back" swipe from the left edge no
  longer takes over the gesture.
- **Swipe to reply** works on short and very tall messages: no more horizontal scrollbar (the
  "bar") or sideways scrolling of the list, no vertical scroll mid-swipe, and the reply arrow
  stays under your finger.
- **Private channels** now notify every member, like DMs (desktop pop-up and phone push), not
  only on `@mentions`; the sound already played for them.

- **Your display name** shows right away in every client (the desktop app showed the email
  prefix until the directory arrived); names also refresh when the app comes back to the front.
- **Notification sound:** served from a content-hashed URL, so a replaced sound always reaches
  browsers and the desktop app; the volume slider's preview always plays that file, never the
  synthesized fallback.

- **Desktop app notifications on Windows:** none ever appeared, because WebView2 reports the
  window as focused even when it's behind other apps or minimized. The app now asks Tauri for the
  window's focus and reports notification errors in the console (`[desktop]`).
- **Pushes to iPhone (and every device) while another device was merely connected:** the server
  skipped push for anyone with an open connection, so a desktop app left open, or an iPhone that
  had just gone to sleep, silenced every push. It now skips push only while you're actually in
  front of the app on some device (focused within the last 4 minutes).

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
