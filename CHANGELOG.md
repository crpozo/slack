# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Horas: a time log in every channel:** the clock button in a channel's header (or its ⋯
  sheet on phones) opens **Horas**. Whoever works on the project, teammates and externals
  alike, logs what they did each day and how long it took ("2", "2:30", "45m"). The team sees
  everyone's hours by person and by day (this week, this month, all); an external sees only
  their own. **Admins** set each person's hourly rate in that channel and see the cost, per
  person, per entry and in total, updating live as hours are logged. Rates and costs never
  leave the server for anyone else. An entry is deleted by whoever logged it, or an admin.
- **Guests in calls, and call links:** a guest (a client's account) can now see **Join** and
  join the calls of the private channels they're in, like anyone else. In a channel call, the
  team has a **Copy call link** button (in the call and in its small floating window): whoever
  opens the link types their name and waits until someone in the call lets them in (**Let in** /
  **Deny**). They only ever see the call (video and screen share), never the chat, channels or
  anything else, and the link stops working when the call ends. Everyone's tile shows a
  **Guest** or **External** badge.

- **AI News audio keeps playing when you leave AI News:** the summary is now one player for the
  whole app: go to a channel, a board or the calendar and it goes on. A small pill (bottom
  right) shows the time, pauses it, takes you back to AI News, or stops it (✕). A Refresh
  doesn't restart it.
- **AI News at 06:00:** the morning analysis (and its audio and the Claude alert) now runs every
  day at 06:00 Ecuador time (it was 08:00).
- **Transcribe voice messages:** a voice message has a **Transcribir** button under its player.
  The first person to press it gets the text (a spinner while it works), shown under the audio
  in a quiet block; it's kept on the message, so everyone after sees it at once, now and in the
  history, and OpenAI is asked only once per message, even when two people press it together.
  It uses the same Whisper key, model and Spanglish prompt as the AI notes of calls. A message
  with no speech says so.

- **Markdown messages show formatted:** paste (or write) Markdown, from a README, a doc or an
  AI answer, and it's sent as is and shows formatted: headings, numbered and bulleted lists
  (nested), checkboxes, quotes, tables, rules, `[links](…)` and ~~strikethrough~~, plus the
  usual **bold**, _italics_ and code. The message box says "Markdown detected" with a Preview
  before you send. Chat stays chat: only a message that reads as Markdown (a heading, a table,
  a quote, a list of two items or more…) gets it; anything else shows as before.
- **Install as an app, with instructions:** a step-by-step guide (in Spanish, as the phones'
  menus read) for iPhone/iPad (Safari → Compartir → Agregar a inicio), Android (Chrome →
  Instalar app) and computers (Chrome/Edge install, Safari → Agregar al Dock), opening on the
  device you're using. It's in Settings → App and in the phone's More menu; on an iPhone in
  Safari, Home shows a card "Instala MindfulTech como app" (✕ hides it for good). Not offered
  once it's installed. The installed app now opens at `/app` (your first screen; an external's
  first channel), not #general, which may no longer exist.
- **@mentions that work:** typing `@` in the message box lists the people in the conversation
  (a private channel's members, externals marked; the team in a public channel), filtered as
  you type, accents aside. ↑/↓ and Enter or Tab pick one, Esc closes, and it writes the handle
  notifications already match (`@martin`). Messages show mentions highlighted, yours in amber.
- **AI News: an alert when Claude gets a new model:** a banner under the AI News title when
  Anthropic has just released a new Claude model (green, "nuevo modelo disponible") or one is
  on its way: announced, previewed or leaked (amber, "nuevo modelo en camino"). It names the
  model, says what's new in a line and links the stories. It comes from the morning's analysis
  (the AI reads the stories; its word alone never raises it: a story it cites must be about
  Anthropic or Claude) and, between analyses, from the live headlines ("Anthropic launches
  Claude Opus 6"), so it doesn't wait for the next morning. A launch replaces an "upcoming"
  notice; apps, features and prices don't count, only models. ✕ hides it on that device until
  the next one, and the audio summary says it first.
- **AI News audio for the analysis on screen:** an analysis written without its audio (before
  the audio existed, or when making it failed) gets it the first time someone opens AI News:
  "Preparando el resumen en audio…" shows, and the player appears by itself about a minute
  later. After a Refresh, the player now shows up once its audio is ready (it used to need a
  reload). A failed try is retried after 10 minutes.
- **AI News with fewer lines:** the sections' white rules are gone; trends, actions and "Para
  seguir de cerca" sit on soft panels instead.
- **Externals: invite people from outside MindfulTech to a channel:** in a private channel,
  **Invite** now takes an email ("Invite someone outside MindfulTech"). A new address gets an
  account and an email with a temporary password, and joins as an **external**: they see only
  the private channels (and boards) they're invited to, never public channels, other channels,
  DMs, calls, the calendar, the Vault or search. The server enforces it on every read and
  every delivery, not just the screen. Externals already known (from a board) can be picked
  from the list too.
- **You always know a channel has externals:** such channels move to a new **Externals**
  section in the sidebar (desktop and phones) with a 🏢 building icon in amber, the header shows an
  **External** chip, the message box reminds you who's from outside ("Jane is outside
  MindfulTech and can read this channel"), and their name carries an **External** badge in
  messages, in the member list and when picking people.
- **Externals see only the chat they're invited to:** no Boards (unless someone invited
  them to a board), no meeting **Join** or **View in Calendar**, no board of a project channel
  (a new project board never includes them), and never a Vault card's details: they read
  "🔒 A secret shared with the MindfulTech team" instead, live and in history. A secret can't
  be shared (`/secret`) in a channel with externals at all. With nothing shared yet, they see
  a short note.
- **Remove people from a private channel:** its creator or an admin can take someone out from
  the channel's Members tab (two taps). An external loses the channel at once.
- **AI News in audio:** "Escucha el resumen" under the AI News title plays the day's summary
  read aloud in Spanish (about 2–3 minutes): the top stories with why they matter, the trends
  and what it means for MindfulTech. It's made with each analysis (the morning's, or Refresh)
  by Amazon Polly's neural voice "Lupe" (Latin American Spanish), kept for 30 days, and costs
  a few cents a month.
- **Paste keeps its formatting:** text copied from a doc, an email, a web page or an AI answer
  pastes into the message box with its **bold**, _italics_, `code`, code blocks, numbered and
  bulleted lists and headings (as bold lines), written as the markdown messages show, with
  blank lines tidied. Plain text, and code from an editor, paste as before.
- **Admins can delete #general:** it's in the channel's ⋯ menu for admins. It isn't recreated,
  not even by a deploy (the seed now creates #general only on a fresh install, with no channels
  yet): the app then opens your first channel instead (on start, after a deletion, and from
  "Back to channels").
- **Knowledge: a section for informational channels:** channels that inform rather than run a
  project (news, tools, announcements) get their own **Knowledge** section in the sidebar,
  above Channels, on desktop and phones. "News/Tools" and other channels named like that land
  there by themselves (never a project); **Move to Knowledge** / **Move to Channels** in a
  channel's ⋯ menu changes it for everyone, and the choice sticks.
- **Your own channel order:** put your channels in the order you want (by priority, say): drag
  one onto another in the sidebar (desktop), or use **Move up** / **Move down** in its ⋯ menu
  (a long press on phones). The order is yours only, follows you to your other devices, and
  each section (Knowledge, Channels) keeps its own; channels you haven't placed follow, by
  activity.
- **AI Notes by date and by topic:** the notes are grouped under **Hoy**, **Ayer**, **Esta
  semana** and then month by month ("Octubre 2026"), with the heading staying on screen as you
  scroll. A meeting can be filed under a **topic** (Daily Sync, Client Call, Planning, Retro, 1:1,
  Demo, or your own) from its notes panel, for everyone in the call. The hub lists your topics
  with their counts, and picking one shows all of its meetings, not just the ones already
  loaded. The AI's own tags are now labelled "AI tags", to tell them apart.

### Fixed

- **A thinner Vault card in the chat:** a secret shared with `/secret` is now one slim row: its
  title, then the username and the password, both hidden, each with its own 👁 Reveal and Copy
  button, and a small Launch button on the right. The username is already on the card, so it
  needs no PIN; the password still asks for it unless the Vault is open. On a phone the row
  wraps.
- **Vault co-admins:** everyone a secret is shared with can now edit, re-share and delete it, not
  only whoever saved it (and the admins). It stays filed under its saver.

- **Long messages send:** a message could hold 4,000 characters; a long brief pasted from a doc
  failed with "Failed to send" (and "That request isn't valid" on retry). Messages now take up
  to 10,000 characters, and past 8,000 the box shows how many you've used; over the limit it
  says so and won't send, instead of failing after. A message that failed for being long sends
  now with **Click to retry**.
- **Phones: the Home list scrolls:** resting a finger on a channel before swiping opened its
  options and froze the list. A row's options now need a deliberate hold (0.6 s), and any
  scrolling cancels it.
- **Phones: no zoom on text fields:** iPhones zoomed the whole page into fields smaller than
  16px (the AI chat, search boxes…) and the layout stayed zoomed. On touch screens every field
  is 16px now.
- **Pregunta a la IA on phones:** the button sits above the tab bar instead of over it, and the
  chat opens as a full sheet that stays above the keyboard (no more `vh` hiding the field).
  Dialogs and the PDF viewer use the visible height too.
- **Boards on tablets:** next to the sidebar the board's three columns didn't fit and the board
  scrolled sideways; the columns now follow the board's own width (a swipeable strip when
  narrow, three columns with room), and the boards list shows on wide screens (a picker
  otherwise). Long board names end with "…".
- **No sideways panning:** anything too wide is clipped instead of letting the app slide
  horizontally on a phone.
- **Secrets keep their layout:** a secret with several accounts ("Store name:", then its email
  and password) showed every line as a copyable part, and a name ending in ":" was labeled
  "Password". Now "Name:" lines (and a first line that just names the secret) are headings
  over their email and password, and a lone email or password line says which it is.
- **Private channel pushes:** every message in a private channel notifies its other members'
  phones, like a group DM, whether or not it `@mentions` them (public channels stay
  @mentions-only). One shared rule now decides this for the server's pushes and the apps' own
  alerts. A message push also says which conversation it belongs to and who sent it
  (`channelId`, `channelName`, `channelType`, `senderName`), so tapping it opens that chat, and
  the server logs why a message pushed nobody (no one offline, or no device with push turned
  on).
- **Vault: one PIN for 15 minutes:** the Vault no longer asks for the PIN again on every Reveal
  and Copy or each time you come back to it. The PIN opens it for the session (15 minutes),
  wherever you type it (the Vault or a 🔒 card in the chat); it then locks by itself, or with
  the Lock button. The server reveals a password with the open session, or with the PIN.
- **No more `![…](attachment:…)` in task notes:** notes saved before attachments took over
  pasted images still had that markdown in them. The text box now shows them without it, and
  editing saves them clean (the images stay as thumbnails under Attachments). Pasting text that
  carries it, such as notes copied from an older task, leaves it out too.

- **Archive from the sidebar:** a channel's ⋯ menu has **Archive channel** (for its creator or
  an admin), next to Pin to the top, Edit channel and Delete channel. It asks first, then
  archives the channel. If you were in it, the app moves you to #general, as Edit channel does.
- **Pasting a screenshot into a task's notes no longer writes `![…](attachment:…)` into the
  text.** The image (or any pasted file) uploads in the background and joins the task's
  attachments, where images show as thumbnails; the notes stay plain text. Cards show a task's
  images as before.

### Security

- **Vault PIN and access control:** the Vault now opens on a lock screen.
  - **PIN:** everyone chooses a 4-digit PIN on their first visit. It unlocks the list for 15
    minutes and is asked again before any password is revealed or copied.
  - **Lockout:** five wrong PINs in a row lock it for 15 minutes, then for twice as long each
    time, up to a day. An admin can reset a forgotten PIN.
  - **Storage:** the PIN is kept as a bcrypt hash, itself encrypted with the Vault's KMS key.
  - **Access:** admins see every secret; everyone else sees only the ones they saved or that were
    shared with them. Create Secret and Edit Secret have a people picker for that.
  - **Locked down in AWS:** the Vault's server permissions only allow reading secret details,
    never the encrypted passwords, when listing.
  - **Launch:** each secret's website has a **Launch** button. It opens a new tab, or your default
    browser in the desktop app.

### Fixed

- **Spanish words aren't passwords:** the password detector counted accented letters ("ü", "ñ",
  "é") as symbols, so a word like "Averigüu" was sent as a secret. Letters in any language now
  count as letters.
- **Delete is visible:** the trash icon is in a message's hover toolbar on desktop (it was only
  behind right-click and the phone's long press), for your own messages and, for admins, anyone's,
  secrets included.
- **AI News with the chat open:** the layout now follows the room the news have, not the window.
  With "Pregunta a la IA" open the stories 02–06 no longer squeeze into a narrow column (their
  titles broke one word per line under the picture): Lo esencial stacks, the list keeps its
  pictures when there's room and drops them when there isn't.
- **AI News on phones:** the page no longer slides sideways. A long story title under a trend
  stretched its column past the screen; every single-column section now stays the screen's
  width, and the page never scrolls horizontally.

### Added

- **Vault:** a password manager for the team's credentials, under APPS (lock icon). Each secret
  has a title, website, username and password, and belongs to a channel (its project): only that
  channel's members can **Reveal** or **Copy** it.
  - **Create Secret** includes **Generate strong password** (24 random characters), and
    `/secret <title> <password>` in a channel saves one and posts a "🔒 Shared a Secret" card
    there with Reveal and Copy. `/secret` on its own still turns on the 24-hour secret mode.
  - Passwords are encrypted with a dedicated AWS KMS key before they're stored. The database only
    holds the encrypted blob, listings never include it, and each reveal checks channel membership
    and is logged.
  - A revealed password hides itself after 30 seconds. In the desktop app 0.4.0, **Copy** uses the
    native clipboard and wipes the password 30 seconds later.

- **AI News as a newspaper:** a new editorial look on the dark background. A serif masthead with the date and
  story count, the sections as tabs (the one you're reading underlined in green), the lead story
  large with its picture beside the numbered 02–06 (each with its own picture), the MindfulTech actions on a dark band ("Cinco
  acciones sugeridas para esta semana", each with when it applies), the trends in four columns,
  then A fondo, Para seguir de cerca and Más historias. Stories without a picture show a lined
  placeholder with their source.
- **Pregunta a la IA opens on demand:** on wide screens the chat is closed by default and the
  news use the whole width; the **Pregunta a la IA** button beside Refresh news opens it at the
  side, and its ✕ closes it. The choice is remembered, and the conversation stays while it's
  closed.
- **Pregunta a la IA (AI News):** a chat about today's news, answered by Claude Haiku 5.5 from the
  day's stories and the morning's analysis. Answers cite the stories they rely on as numbered
  links to the articles, with the sources listed below. It sits beside the news on wide screens
  and opens from a floating button on phones; suggested questions get you started, and the chat
  stays while you move around the app (it's never stored).
- **AI News, better organized:** a row of section pills at the top (sticky while you scroll)
  jumps to Lo esencial, Para MindfulTech, A fondo, Tendencias, Seguir de cerca and Más historias.
  "Qué significa para MindfulTech" now comes right after the essentials.
- **AI News analysis progress:** while the analysis is being written, a progress bar shows the
  step it's on and how long it has run. It keeps going on the server if you leave the page: AI
  News in the sidebar spins until it's done, and coming back (even after a reload) picks the
  wait up again.

### Fixed

- **AI News flickering:** the sticky section bar blurred what scrolled under it, and the cards
  and sections under it blurred their own backgrounds too; stacked like that, Chrome
  recomposited them every frame while scrolling, which showed as flicker. The page no longer
  uses backdrop blur (the bar is solid; the look is the same on its plain background), and the
  analysis progress bar repaints once a second instead of four times.
- **AI News images:** TechCrunch's feed carries no images, so its stories always showed the
  placeholder icon. A story without an image now gets the article's own cover (its `og:image`,
  what chat apps show for a link), read once per article from the page's head, a few at a time
  with a short timeout. A page that can't be read keeps the placeholder.
- **AI News analysis still stuck:** the streamed request (below) needs its own Bedrock permission,
  which the worker didn't have, so every run was refused. It has it now. Also, the deep dive and
  "Para seguir de cerca" were written but never sent to the page; they are now. And if a run ever
  fails again, the page stops waiting at once and says why ("the AI service is busy", "permissions",
  …) instead of after several minutes.
- **AI News analysis stuck:** with the deeper analysis (40 stories, more reasoning) a run took
  longer than the 50 seconds each model request was allowed, so it failed and the page gave up
  after a minute and a half. The request is now streamed with up to 5 minutes (the worker has 6),
  and the page waits up to 7.
- **AI Notes, meeting cards:** the hub now uses the whole screen. Filters (search, categories,
  topics) sit in a column on the left; each meeting is a card in a grid of two or three: its
  category, time and length, a short title written by the AI ("Rediseño del render de Draw My
  Fence"), the opening of the summary, a few topics, and what came out of it (action items, a
  recording, tasks sent to a board). A card opens the full notes in a side panel (a sheet on
  phones). **Organize** also gives older notes their title.
- **AI Notes by category and topic:** every call's notes are now filed by the AI as they are
  written, under one category (Client, Project, Planning, Sales, Support, Technical, Team, Other)
  and a few topics in the call's language. The AI Notes hub has a search box (summaries, topics
  and people), category chips with counts, the most used topics as tags, and each card shows its
  category and topics, all clickable to filter. Notes from before get an **Organize** button that
  files them in batches; each card updates live.
- **Download really downloads:** the download button on files, in the PDF viewer and in the
  image viewer now saves the file under its name instead of opening it in a tab (S3 is told to
  serve it as an attachment; browsers ignore `download` on another site's links). **Open** and
  **Preview** still open it.
- **AI News, a deeper analysis:** the morning run now reads up to 40 stories (12 per source,
  last 48 hours; it was 24 and 8) and reasons at high effort before writing. The dashboard gains
  **A fondo** (the day's story taken apart: background, what it changes for us, open questions),
  **Por qué importa** on each of the six top stories (six, not four), the stories each trend
  rests on as links, a horizon on each takeaway (this week, this quarter, watch) and **Para
  seguir de cerca**, what to follow in the coming days.
- **Boards on phones:** a To Do / In Progress / Done tab bar with counts sits over the columns;
  tap one to go to that column, and it follows as you swipe. A floating **+** adds a task from
  anywhere on the board. Cards have bigger targets, no trash icon (Delete is in the card's ⌄
  menu, one more tap away from an accident), and the board header fits one line.
- **Quoted replies jump:** clicking the quote above a reply now goes to the original message,
  loading older history until it's there, like "Jump to message" on pins. No more "That message
  is further back in the history".
- **AI Skills:** a new app under APPS (a puzzle-piece icon below AI News) with the team's catalog
  of Claude Code skills. Search by name, command or description, and filter by team, GitHub,
  security or development.
  - Each card shows the skill's `/command`, where it comes from (its GitHub repository or the
    teammate who wrote it) and quick actions.
  - Its detail drawer shows the rendered `SKILL.md` and every file.
  - **Inicializar** gives a command to copy (bash/zsh or PowerShell, project or global), a `.zip`
    download, or, in the desktop app 0.3.0, a one-click install into `~/.claude/skills`.
  - **Importar de GitHub** reads a skill from a public repository (with a preview), and **Sync
    from GitHub** updates it.
  - **Crear Skill** takes a written or uploaded `SKILL.md`, or an idea that Claude Haiku 5.5 turns
    into one (**Generar con IA**).
  - The catalog starts with Cloudflare's security-audit skill.

- **Share your screen from the small call windows:** the floating call (shown while you're
  elsewhere in the app), the browser's picture-in-picture window and the desktop app's
  always-on-top call window now have a **Share screen** button next to the microphone and camera,
  so there's no need to go back to the full call. In the desktop app the small window captures the
  screen itself (the OS picker opens for that click) and hands it to the call. The same button
  stops sharing, whichever window started it.

- **AI notes now use OpenAI Whisper:** a call's speech is transcribed by Whisper instead of the
  browser. Whisper is told it's a MindfulTech software meeting in Spanish with English technical
  terms, so "deploy", "endpoints" or "dashboard" come out as said. Each voice is recorded on its
  own in clips of up to 4 minutes and sent as it ends, so the notes know who said what and are
  ready moments after hanging up. The notes themselves are still written by Claude Haiku 5.5,
  which now keeps English technical terms in English. Needs the OpenAI key in Parameter Store
  once per stage (see the README).
- **The audio is private by default:** each clip is transcribed from memory and discarded. Only
  the text is kept, and the call's audio is no longer saved. A small **Guardar audio original
  como respaldo** switch under the call controls (shown while notes are on, off by default, either
  person can change it and both are told) keeps the original audio with the notes. The ✨ card
  shows the audio player only when there is audio.

- **Search every message (Ctrl K / ⌘ K):** the palette now finds messages as well as channels and
  people, in every conversation you can see. It searches while you type, after a short pause,
  ignoring accents and case ("reunion" finds "reunión"), and finds a word from its start ("logi"
  finds "login"). Matches are highlighted, and arrow keys and Enter open a result: its
  conversation, scrolled to the message and highlighted, or its thread for a reply. The sidebar
  button reads **Search…** and the phones' Search tab finds messages too. Secrets and deleted
  messages are never searchable. After deploying, index the existing history once with
  `pnpm --filter infra backfill-search <stage> --apply`.

- **The AI News dashboard:** the News view is now the "AI News Dashboard" design. It has a glass
  card for each of the day's four top stories (thumbnail, a Spanish headline and summary, the
  source and how long ago). Below them come **Tendencias** with the key phrases highlighted, the
  glowing **Qué significa para MindfulTech** callout of takeaways, and every other story under
  **Más historias**. It replaces the analysis that was one block of Markdown text.
- **Four news sources:** TechCrunch, VentureBeat, The Verge and InfoQ, read at once and merged
  (newest first, the same story once, at most 8 per source). The Verge's Atom feed is read too,
  and only its AI stories are kept. A source that's down or returns garbage is left out, and a
  missing image never looks broken: the thumbnail keeps its square, rounded box and shows a faint
  brand-green-to-slate gradient with a muted Lucide icon (a chip for hardware stories, a newspaper
  otherwise). The same happens for an image that fails to load or is a tracking pixel, and a slow
  image fades in over that tile once it has loaded.

### Fixed

- **Markdown tables render as tables:** a `| Column | Column |` table in a `.md` file preview, an
  AI note or a skill's `SKILL.md` showed as raw text with pipes. Tables (with `:---:` column
  alignment) and `~~strikethrough~~` now render, styled to the dark glass theme: a subtle border,
  padded cells, a tinted header row, and a horizontal scroll for wide tables on a phone.

- **Archiving a channel no longer crashes the app:** archiving the channel you were in, or
  opening an archived channel's link, left a blank dark screen. The message box swapped itself for
  the "archived" note in a way React can't handle while it's on screen, and nothing caught the
  error. Now archiving the channel you're in takes you to #general (or the first active channel),
  drops it from your recent places and says where it went. An archived channel opened by link shows
  read-only, with an **Unarchive** button for whoever may restore it. A view that fails to render
  now says so, with a way to #general, instead of blanking the whole app.
- **An expanded call fits the window:** expanding a call (the ⤢ button) in a short window, such as
  a maximized desktop app above the taskbar, pushed the call's controls below the bottom edge. The
  call now shrinks to the space there is, with its controls always in view.
- **AI News shows only news:** stories published more than 48 hours ago (weeks-old ones the feeds
  still carry) no longer reach the list or the morning analysis. Each feed's stories are dropped as
  they're read, before the per-source limit, and so are the ones whose date can't be read. Dates
  are read the way each source writes them (RSS's `pubDate` with any time zone, Atom's ISO dates,
  and a few near-misses). A list kept in memory loses its stories as they pass 48 hours.

### Changed

- **Inviting to a private channel:** an admin in the channel can invite too, not only its
  creator. Guests on boards are now called **externals** (badge "External").

- **AI Insights are structured:** Claude Haiku 5.5 returns the dashboard as JSON held to a schema
  (structured outputs on Bedrock). It names its top stories by their number in the list, so links,
  thumbnails, sources and dates always come from the feeds, never from the model. Picks out of
  range or repeated are dropped, and over-long text is cut. Rows from before the change aren't
  shown: until the next morning's run (or a **Refresh news**), the dashboard shows the newest
  stories as they are.
- **Refresh news starts a new analysis:** besides reading the feeds again, the button now runs
  the AI analysis at once (`POST /news/refresh`), whatever the time, and the dashboard shows it
  about half a minute later. Members can start one every 5 minutes (enforced on the server, so a
  burst of clicks is one run), and admins any time. The admin-only **Generar análisis** button is
  gone.
- **The morning analysis runs at 08:00** (Ecuador) instead of 07:07.
- **AI News has an outline icon** in the sidebar, the phone apps and the More sheet, like Task
  Manager, Calendar and AI Notes, instead of the 📰 emoji.

### Security

- **Secrets expire after 24 hours** instead of a week, including ones sent before this change
  (hidden at 24 hours; `shorten-secret-ttl` has DynamoDB delete them on the new schedule).
- **Passwords are sent as secrets automatically:** a message that looks like a credential (an
  email or username with a password, "contraseña: …", a single random-looking string, a URL with
  a login) goes out masked and expiring, with no need for `/secret`. The composer says so
  before you send, and **Send as normal text** keeps it plain.
- **Copy just the password:** a revealed secret with several parts (an email and a password, or
  several lines) has a Copy button for each.

### Changed

- **Toasts match what happened:** a green ✓ for done ("Copied", "Event updated."), a neutral ⓘ
  for information, red only for errors (no more red dot on every toast). They slide in on frosted
  glass, go after 3.5 s (success), 5 s (info) or 7 s (errors), and errors are announced at once
  to screen readers.
- **A new audio player for voice messages and audio files:** a round green Play/Pause, a progress
  bar you can click, drag or move with the arrow keys, the time played and the length, and the
  1× / 1.5× / 2× speed button, on a dark glass card instead of the browser's own controls.
  Starting one clip pauses any other, and a voice message shows its length before it has loaded.

### Fixed

- **Scrolling up through history no longer jumps:** loading an older page moved the message you
  were reading by about 72 px each time, on phones and desktop. The "Loading earlier messages…"
  line sat inside the first row and changed its height, and so did that row's date line once
  older messages of the same day arrived above it. Nothing above the viewport moves what you're
  reading now, including images loading up there. On touch screens the correction waits for the
  scroll's momentum to end.

- **"Couldn't open the link" after the link had opened:** a browser answers `window.open` with
  `null` when the link opens in a new tab without access back to the app (`noopener`), and the
  desktop app does the same when it hands the link to the system browser, so Open link, file
  downloads and task attachments reported a failure (and tried to copy the link) every time.
  Opening a link no longer reports anything; the desktop app falls back to the browser only when
  its opener is missing, never opening a link twice.
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

- **AI call notes, "Wispr Flow" style:** call notes now come with the call's recording, polished
  minutes and your own questions.
  - **Spanish, always:** calls are transcribed in Spanish (Ecuador) whatever your browser's
    language, so speech and background noise no longer turn into random English words.
  - **The recording:** while AI notes are on, the call is recorded (both voices; both people are
    told) and the ✨ card gets a player once the call ends.
  - **Polished minutes:** Claude rewrites the whole conversation as clean minutes, fixing
    recognition errors and dropping filler words while keeping every fact, name, figure and
    commitment. **Open full notes** on the card shows them; **View original transcript** shows
    what the browser heard.
  - **Ask about the call:** "Ask a question about this note…" answers from that call's minutes
    only. Your questions and answers are private: the other person never sees them.
  - Deleting the card deletes its recording, transcript, minutes and questions.
- **Send without waiting:** attach images or files and send right away, then keep typing and
  sending; nothing waits for uploads any more.
  - **Shows at once:** each message appears immediately, slightly faded with "Sending…", its
    images shown from your own copy with a progress bar while they upload.
  - **Always in order:** messages go out in the order you sent them; a text sent after an image
    waits for that image, like in Slack.
  - **Failures:** a message that couldn't be sent says **Failed to send · Click to retry**, and
    the ones after it still go out. Retry uploads again only what failed.
  - **No flicker:** when the server confirms a message its images don't blink.
  - **Voice messages** work the same way.
  - Closing the tab while something is still sending asks first.
- **AI Insights:** the AI News view opens with the morning's analysis of the day's stories,
  written by Claude Haiku 5.5 on Amazon Bedrock in Spanish: what matters, the trends behind the
  stories, what they mean for MindfulTech and what to watch next. A scheduled worker writes it
  every day at 07:07 (Ecuador) from the same TechCrunch feed and keeps one per day; the view
  shows the newest. Admins can ask for one now with **Generate now** (and **Generate again**
  later in the day).
- **Channel icons:** private channels show an icon for what they are about instead of the
  padlock, read from their name: a browser window for a website, a newspaper for news, layers
  for a platform, a pen for design, code brackets, coins for payments, a life buoy for support,
  a database, a megaphone for marketing, a phone for apps. A project channel with no such word
  gets a board; any other private channel, a group of people. Public channels keep the `#`.
  Screen readers still hear "Private channel".
- **Board icon:** Task Manager and "Mark this channel as a Project" use a proper board icon
  (three columns of cards) instead of three bars.
- **Archived:** the whole "Archived" row in the sidebar now opens and closes the section,
  not only its chevron.
- **Sidebar:** opens 288 px wide (was 256), so the header shows the logo and "MindfulTech"
  without cutting the name. A width you dragged to is kept; the old default moves to the new.
- **Refresh news:** the button in the AI News header now says so, and really reads the feed
  again (the server kept a list for 30 minutes and the old button only repeated it). Once a
  minute at most.
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
