# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- **AI Insights was cut off:** Claude Haiku 5.5 thinks before it writes and the thinking counts
  toward the response ceiling, so the 2048-token ceiling ran out before the page was done and the
  morning analysis was never saved. The ceiling is now 8192; the page itself stays under 400 words.
- **AI call notes and AI Insights were failing:** the workers asked for Claude Haiku 5.5 through
  Bedrock's Mantle endpoint, which doesn't serve that model for this account (`404 The model
'anthropic.claude-haiku-5-5' does not exist`), so every card ended in "Something went wrong
  writing the notes". They now use the standard Bedrock runtime (`InvokeModel`) with the
  `us.anthropic.claude-haiku-5-5` inference profile, and the stack grants `bedrock:InvokeModel`
  on exactly that profile and its model instead of `bedrock-mantle:CreateInference` on `*`.

### Added

- **AI Insights:** the AI News view opens with the morning's analysis of the day's stories,
  written by Claude Haiku 5.5 on Amazon Bedrock in Spanish: what matters, the trends behind the
  stories, what they mean for MindfulTech and what to watch next. A scheduled worker writes it
  every day at 07:07 (Ecuador) from the same TechCrunch feed and keeps one per day; the view
  shows the newest. Admins can ask for one now with **Generate now** (and **Generate again**
  later in the day).
- **New version banner:** a tab opened before a deploy now notices the new version (when it
  comes to the front, when the browser is back online, and every 15 minutes) and shows a banner
  at the top: **Reload** gets the update, **Later** hides it for that tab.
- **Pinned conversations:** a **Pinned** section at the top of the sidebar (and of Home on
  phones) holds the channels and DMs you pin; they leave their usual section. Pin one from its
  menu (right-click on a computer, a long press on a phone), from the conversation's **⋯**
  menu, or from its options on a phone. Up to 30, synced across your devices.
- **Pinned messages:** **Pin to channel** on any message (its hover toolbar, its right-click
  or long-press menu) pins it for everyone in the conversation, up to 100.
  - **Label:** a pinned message says who pinned it.
  - **Panel:** the 📌 in the header, with the count, lists them, newest pin first, each with
    **Jump to message** (it scrolls back and loads older messages as needed) and **Unpin**.
  - **Limits:** secrets and deleted messages can't be pinned; archived channels are frozen.
- **Files & Links:** channel and DM details have tabs: **About**, **Members** and **Files &
  Links**.
  - **Files:** every shared file, newest first. Images and PDFs open in the app's viewers;
    anything else opens in a new tab.
  - **Links:** every link shared, newest first. Each opens in a new tab (the system browser in
    the desktop app).
  - **Jump to message** on each one; **Show more** loads older ones.
  - **Fast on long conversations:** they come from a small per-conversation index kept as
    messages are sent, edited and deleted, not from scanning the history. Files and links
    shared before this release appear once the backfill has run (see the README).
- **Glass:** the sidebar, conversation headers, menus, dialogs and the phone tab bar are now
  translucent and blurred, iOS-style, over a soft dark background with faint purple and blue
  light in the corners. Messages scroll under the header.
  - **Desktop app (0.2.0):** on macOS and Windows 11 the window itself is translucent, and the
    system blurs the desktop wallpaper behind the sidebar. Windows 10 and Linux keep a solid
    window, since the blur would slow them down. Install the new version to get it; older
    versions keep working as before.
  - **Readability first:** with "Reduce transparency" (macOS, iOS) or transparency effects off
    (Windows), everything turns solid.
- **New phone design:** phones now follow Slack's mobile app in its dark look, whatever the
  theme setting. Purple replaces the teal on phones; computers don't change.
  - **Tab bar:** Home, DMs, Activity and More in a floating bar, Search in its own circle, and a
    purple **+** for a new message, channel or task. The bar stays inside conversations and folds
    away while you type.
  - **Home:** the workspace header with your recent conversations (kept on this phone only), and
    shortcuts to Huddles (calls going on now), Activity, Tasks and Calendar.
    - **Sections:** Channels, Direct Messages and Apps fold away, and stay that way.
    - **Status:** a green dot when someone is online, a "z" when not.
    - **Row options:** a long press opens them.
  - **Conversations:**
    - **Header:** a back button, the name and member count in a pill (tap it for details, people,
      the board or a video call), and 🎧 to start or join the channel's call.
    - **Start of a channel:** "This is the very beginning of #channel", with _Add description_ and
      _Add people_.
    - **Composer:** a rounded field with **+** for files, emoji, meetings and secrets, and the mic
      until there's something to send.
- **AI News:** a new app under Apps, with the latest AI stories from TechCrunch.
  - **Layout:** the newest is featured, the rest in a grid with image, headline, summary and date.
  - **Reading:** any card opens the article in a new tab, or the system browser in the desktop app.
  - **Refresh:** the list refreshes every 30 minutes. Nothing is stored: it's read live from the feed.
- **Calls in channels:** start a voice or video call from any channel's header. People join
  from the header (who's in it shows there) or from the in-app notice; nothing rings.
  - **Size:** up to 6 people, each connected directly to every other (no media server, so no
    media costs).
  - **In the call:** a grid of everyone, screen sharing, mute and camera, and a floating window
    while you look elsewhere.
  - **When it ends:** the last one out posts the call's length in the channel.
- **Meetings in channels:** _Post to a channel_ in the calendar, and _Schedule meeting_ in a
  channel's composer, put the meeting's card in the channel; its **Join** opens the channel's
  call.
- **Voice note speed:** a 1× / 1.5× / 2× button next to every voice note and audio file,
  remembered on each device.

- **Passwords:** the first sign-in with an emailed temporary password now has a proper
  "Choose your password" screen.
  - **The screen:** confirm field, show/hide, the rules ticked off as you type, and a way back.
  - **Clear errors:** a password step left open over 3 minutes sends you back to sign in with a
    clear note, and an expired invitation says to ask for a new one.
  - **Forgot password?** emails a code to reset it, then signs you in.
  - **Change password:** in Settings, and behind the lock button for guests.
- **Recurring meetings:** a _Repeat_ menu (daily, every weekday, weekly, monthly, or custom:
  every N days/weeks/months on chosen weekdays) that ends never, on a date or after N meetings.
  - **In the calendar:** each meeting is drawn with ↻. A single meeting can be cancelled
    (_Cancel this meeting_) without touching the rest; _Edit series_ and _Delete series_ change
    or remove them all.
  - **From a DM:** _Schedule meeting_ can repeat too.
- **Meeting cards for everyone invited:** a meeting made in the calendar now puts a card in each
  invitee's DM with the organizer (starting the DM if needed), so everyone has a lasting **Join
  call** at the time.
  - **Repeating meetings:** the card shows the rule and the next meeting.
  - **Edits** update every card.
  - **People removed, or the meeting deleted:** their cards stay in the chat, marked cancelled.
- **Calls survive network drops:** when the connection drops mid-call (Wi-Fi to cellular, a
  flaky access point), the call shows **Reconnecting…** with a countdown and restores itself
  (ICE restart) instead of hanging up; it ends only if it isn't back within 30 seconds.

- **Close the pop-out call:** a ✕ in the pop-out window closes it without switching windows,
  and the call carries on in the app. In the desktop app it then stays closed when you switch
  away again during that call; **Pop out** brings it back on demand.
- **Paste images into tasks:** paste a screenshot into a task's Details or Notes. It uploads
  (showing "Uploading image…"), becomes one of the task's files, and appears as a preview, with a
  thumbnail on the card. The text keeps a short `attachment:` reference rather than a download
  link, so the image keeps working after the link would have expired.
- **YouTube previews:** a YouTube link in a message (`watch`, `youtu.be`, Shorts, live,
  start times) gets a thumbnail with a play button that plays in place when clicked. Players
  only load when clicked, so a channel full of links stays fast.

- **Delete messages:** _Delete message_ (red, with a trash icon) at the end of a message's
  right-click menu, and in the long-press bar on phones. It's there for its author and for
  workspace admins, who can moderate anyone's message. A confirmation shows what goes, and it
  disappears for everyone at once (`message.deleted`), files included.
  - **Messages with replies** stay as "This message was deleted" so their thread survives.
  - **Deleting a reply** updates its thread's counters.
  - **Quotes** of a deleted message lose the copied text and say "Original message deleted".
  - **Offline devices** drop deleted messages when they next refresh the conversation.
- **Delete boards, safely:** the board's owner or a workspace admin can delete it from the board
  settings, after typing the board's exact name.
  - **Two phases:** the board disappears for everyone at once and nothing new can be added, then
    its tasks, files and project-channel links are removed.
  - **Safety net:** an interrupted cleanup is finished by the daily job, which also removes any
    tasks left without a board.

- **✨ Send to Board:** a ready AI notes card has a _Send to Board_ button that turns its action
  items into tasks in To Do. The parser reads the "Action Items" section in English or Spanish
  (Action Items, Next steps, To-do, Tareas, Próximos pasos, Pendientes, Compromisos…), whether
  written as `#` headings, **bold** lines or `Label:` lines. Top-level bullets become tasks;
  nested bullets become the task's details; `[x]` items are skipped. An owner written as
  `**Ana**: …`, `(Responsable: Ana)` or under an `### Ana` heading becomes the assignee when they
  are on the board.
  - **Review first:** a dialog shows the items before anything is created. It preselects the
    board of a project channel both people are in, else the last board used, and anything wrong
    can be unticked.
  - **Atomic and once only:** `POST /boards/{id}/tasks/from-notes` writes every task and marks
    the card in one DynamoDB transaction, so a card reaches a board once, whole or not at all,
    from either person.
  - **One notification:** the board's members get a single alert and push ("Carlos added 3
    tasks from ✨ AI call notes"), and both people see "3 tasks sent to Website" on the card.
- **✨ AI Notes hub** (`/app/notes`): every notes card from your conversations, newest first,
  grouped by day, with a filter by person and _Open conversation_.
  - It's in the sidebar's Apps section and in the phones' More sheet.
  - Older pages load as you scroll, and new cards and their updates appear live.
  - `GET /notes` reads a per-person index table (`meeting-notes`: one entry per participant,
    written in the same transaction as the card) plus one batch get of the cards. There is no
    scan or GSI over the messages table.
  - `pnpm --filter infra backfill-notes <stage> --apply` adds the entries for earlier cards.

- **✨ AI call notes:** during a DM call, the ✨ button (off by default) switches notes on for
  both people. The other person is told who turned them on, and a "✨ AI notes" badge stays on
  the call, the floating card and the popped-out window. Each side transcribes only its own
  voice with the browser's speech recognition: on-device in Chrome when the language pack is
  installed, otherwise the browser's speech service. Recognition pauses while muted, and
  finished phrases cross the call's data channel, so both sides hold one timeline. When the call
  ends, the caller sends it to `POST /calls/summary`, which answers `202` and posts a pending
  ✨ _AI Call Notes_ card at once. A worker Lambda then asks Claude Haiku 5.5 on Amazon Bedrock
  for a summary and the action items, and the card fills in live (`message.updated`). The
  transcript is never stored. The model's markdown (headings, `-`/`*`/`•`/numbered bullets,
  nesting, checkboxes, links) renders through an escape-first block renderer, so HTML a
  transcript coaxes out of the model shows as text.

- **Right-click menu on messages (desktop):** quick reactions, _Copy text_ (or _Copy selection_
  when part of the message is selected), _Open link_ / _Copy link_ on a link, then _Reply_,
  _Reply in thread_ and _Edit message_ (your own). Arrow keys, Enter and Esc work; a click
  elsewhere, scrolling or leaving the window closes it. Images keep the browser's own menu, and
  touch screens keep the long-press toolbar.
- **Resizable side pane:** a draggable divider between the conversation and the thread or board
  pane (30% to 70%, keyboard accessible, remembered per pane kind); phones keep full-screen views.
- **Priority chats:** the sidebar orders channels and direct messages by their latest message,
  `#general` always first. The server records `lastMessageAt` on the conversation and the app
  bumps it as `message.new` arrives, so whoever writes jumps to the top at once (pinned DMs keep
  their place; people you've never written to sit at the bottom, alphabetically).
- **Board beside the chat:** on desktop, a project channel's **📊 Board** pill now opens its
  Kanban board in a 50/50 pane next to the conversation instead of leaving it; the board is the
  Task Manager's own (live, drag and drop, task details) in a compact column strip. A thread
  takes the pane while open; _Open full view_ goes to `/app/tasks`. Phones keep opening the Task
  Manager full screen.
- **Picture-in-picture outside the app:** _Pop out_ on a call keeps it visible over other apps
  and windows. The desktop app opens a small always-on-top window on its own when you switch
  away and closes it when you come back; Chrome and Edge use Document Picture-in-Picture with the
  full controls; Safari uses the video's picture-in-picture; elsewhere the floating card remains.

- **Threads:** _Reply in thread_ on any message; parents show "N replies · last reply" with the
  repliers' avatars. The thread opens beside the conversation on desktop and as its own screen on
  phones, with its own composer. Replies live under their parent's sort key
  (`thread#<parentSk>#…`), so the channel's history never sees them and a thread is one query;
  the parent's counters are kept by the server in the same transaction as the reply.
- **Phones: bottom tab bar** (Home, DMs, Activity, Search, More) instead of the side drawer, like
  Slack's app: the active tab's icon sits in a pill, the bar paints edge-to-edge under the home
  indicator, and More opens a sheet with your profile, the theme (light/dark/system), Settings and
  Sign out. A conversation opens on top with a back arrow; Home also links to Tasks and Calendar.
- **Slash commands:** typing `/` at the start of a message lists the commands (`/secret`,
  `/shrug`, `/clear`), filtered as you type; arrows, Enter/Tab and Esc work. New commands are one
  entry in `lib/commands.ts`.
- **Archive channels** (admins): _Archive channel_ in a channel's details makes it read-only
  (banner instead of the composer) and moves it to a collapsed _Archived_ section of the sidebar;
  it stays searchable and can be restored. `#general` and DMs can't be archived.

### Removed

- **Light theme and the theme setting:** MindfulTech is now dark everywhere, with Slack's
  palette and purple accents (computers too, not only phones). The teal accent is gone; the logo
  keeps its colours.
- **Channel canvas** (merged in #40, withdrawn): the rich-text document beside the chat, its
  `canvas` Lambda and routes, the `canvases` table, the `canvas.updated` push and the TipTap and
  `sanitize-html` dependencies. The split pane it introduced now shows project boards. In prod
  the table is retained by its removal policy: delete `slack-prod-canvases` by hand once nothing
  in it is needed.

### Changed

- **Faster Lambdas, same bill.** Every handler is now bundled as an ES module (the AWS SDK's
  ESM entry points tree-shake), which makes each bundle 25–30 % smaller (`message` 1.75 → 1.26 MB,
  `ping` 1.14 → 0.84 MB): less to download and parse on a cold start. They also run with 512 MB
  instead of 256 MB: CPU scales with memory on Lambda, and these handlers spent their time
  parsing the bundle and signing requests, not waiting on DynamoDB, so cold starts and short
  invocations take about half the time. At this team's volume the difference in cost is within
  rounding, inside the free tier.
- **Cheaper cold storage, done right.** Attachments still move to Glacier Instant Retrieval after
  90 days, but only when they are larger than its 128 KB minimum billable size: below it every
  object was billed as 128 KB (more than Standard for thumbnails and small files) plus a transition
  request each. Abandoned multipart uploads, should a client ever start one, are removed after 7
  days instead of being billed forever.
- **HTTP/3 on CloudFront** for browsers that support it: faster connection setup and better
  behaviour on lossy phone networks, at no extra charge. HTTP/2 stays for the rest.
- **Pinned DMs** now sit in the sidebar's Pinned section instead of at the top of Direct
  messages. The pinning limit is 30 conversations (was 20).
- **Archiving a channel:** its creator can now archive and restore it, not only admins.
- **Opens instantly.** The shell paints for the last signed-in person before Amplify has verified
  the session, and the channel list, directory and the newest 50 messages of every channel you
  opened are kept in IndexedDB per user: a conversation shows its cached history the moment you
  open it while a fresh page loads behind it. A reconnect no longer throws cached history away;
  it only marks it stale. Secrets and unsent messages are never cached; sign-out wipes the cache.

### Fixed

- **Unread badges that came back:** a channel with threads showed unread messages again after
  every reload or reconnect, however often you read it.
  - **The cause:** the server counted thread replies as unread, and your read position can
    never move past them.
  - **The fix:** it now counts only the channel's own messages, and a read position that didn't
    reach the server is sent again after a reconnect.
  - **Thread replies** no longer raise the channel's badge (like Slack).
- **Deleted meetings' cards:** deleting a meeting no longer leaves its DM card showing the old
  time; the card is marked cancelled.
- **Join call** on a meeting card in a DM now always calls the other person of that DM.
- **Line breaks in task details and notes:** pressing Enter in them no longer makes saving
  fail; other control characters are still refused.
- **Links no longer trap you in the desktop app:** every link to another site (messages, the
  image viewer, the PDF viewer, file downloads, task files) opens in the computer's default
  browser through Tauri's opener plugin. The web keeps opening them in a new tab. Desktop builds
  without the new permission fall back to the app's own browser routing, then to copying the link.
- **Compact image previews:** images in messages are at most 384×300 (aspect kept, never
  stretched), like Slack, instead of spanning wide monitors; the viewer still opens the original.

- **New messages stopped arriving until a reload.** A WebSocket can stay "open" after the
  laptop sleeps or the network changes while nothing reaches it any more. The heartbeat's
  `ping` never got an answer, so the app couldn't tell a dead socket from a quiet one and kept
  waiting. `ping` now asks for a `pong`; if nothing comes back within 10 seconds the app
  reconnects and reloads the open conversation. The probe also runs when the app comes back to
  the front and when the browser goes back online.
- **The bell kept alerts of conversations you had read.** Opening a channel or DM (or reading it
  on another device) now marks its alerts in the Activity bell as read, like its unread badge.
- **Channel icons:** a private channel always shows the padlock and a public one the hash; a
  project channel no longer replaces either (its header keeps the 📊 Board pill).

- **Living meeting cards:** a meeting scheduled from a direct message used to leave a snapshot
  in the chat, so moving the meeting in the calendar left the card showing the old time. The
  event now remembers its card (`channelId`, `messageId`, `messageSk`), an edit rewrites the card
  in the same DynamoDB transaction as the event, and the conversation gets a `message.updated`
  push with the new card, so it re-renders at once. The card also draws from the live event when
  the calendar store holds it.
- The conversation now reliably opens at the newest message, and the read mark is sent only once
  the newest message has actually been painted (a frame after the rows are measured), instead of
  from the scroll handler, which never ran on an open that landed at the bottom by itself.

- **Calendar on phones, iOS style:** under 768 px the month grid gives way to a continuous
  vertical list of days (earlier months above, later below, loaded as you scroll), each with its
  events as colored pills (meeting, vacation, pending, holiday) and today in a red circle. The
  header is just the month and year (tap it, or the floating _Today_ pill, to come back to
  today) and a "+" button; the vacations panel sits behind one row above the list. Desktop keeps
  the Month / Week / Day grid.
- **Join call from a meeting card:** from five minutes before a meeting starts until it ends,
  the card in the DM shows _Join call_, which starts the video call with the other person. The
  card re-checks the clock every minute, so the button appears on its own.

- **Schedule a meeting from a direct message:** a calendar button in the DM composer opens a
  small form (title, date, time, details); the two people of the conversation are the
  participants. One request creates the calendar event and posts a **meeting card** in the chat
  (title, when, details, both people, _View in Calendar_), written together in a single DynamoDB
  transaction so the calendar and the conversation never disagree. Cards can be replied to and
  reacted to but not edited; the calendar event is the source of truth.

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
