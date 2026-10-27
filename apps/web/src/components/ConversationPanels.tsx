import {
  canEditChannel,
  canPinMessage,
  dmChannelId,
  isDmChannel,
  type Channel,
  type ChannelFile,
  type ChannelLink,
  type MediaSource,
  type Message,
} from "@mindfultech/shared";
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { chat } from "../lib/chat";
import { dmPeer, formatDay, formatTime } from "../lib/channels";
import { isDesktopApp } from "../lib/desktop";
import { openExternal } from "../lib/external";
import { renderMarkdown } from "../lib/markdown";
import { mediaApi } from "../lib/mediaApi";
import { formatBytes, getDownloadUrl } from "../lib/upload";
import { useChat, useNameOf } from "../store";
import { attachmentKind, downloadAttachment } from "./Attachment";
import { Avatar, PresenceDot } from "./Avatar";
import { ExternalLinkIcon, FileIcon, PencilIcon, PinIcon, PinOffIcon } from "./icons";
import { Lightbox } from "./Lightbox";
import { Modal } from "./Modal";
import { PdfViewer } from "./PdfViewer";

// ---------------------------------------------------------------------------
// Phase 38: a conversation's pinned messages, and its details (About,
// Members, Files & Links). Read live from the server's per-conversation index
// (`GET /channels/{id}/pins|files|links`), a page at a time.
// ---------------------------------------------------------------------------

/** Where "Jump to message" goes: a message, or where a file or link was shared. */
export type JumpTarget = Pick<MediaSource, "channelId" | "messageSk" | "parentSk">;

const when = (at: number) =>
  formatDay(at) === "Today" ? formatTime(at) : `${formatDay(at)} · ${formatTime(at)}`;

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong. Try again.";

function JumpButton({ onClick }: Readonly<{ onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/15"
      data-jump
    >
      Jump to message
    </button>
  );
}

// --- Pinned messages -----------------------------------------------------------------

export function PinnedMessagesModal({
  channelId,
  title,
  onClose,
  onJump,
}: Readonly<{
  channelId: string;
  title: string;
  onClose: () => void;
  onJump: (target: JumpTarget) => void;
}>) {
  const nameOf = useNameOf();
  const role = useChat((s) => s.me?.role);
  const me = useChat((s) => s.me?.userId);
  const channel = useChat((s) => s.channels.find((c) => c.channelId === channelId));
  // Any pin or unpin anywhere moves the count: read the list again then.
  const pinCount = channel?.pinCount ?? 0;
  const [pins, setPins] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    mediaApi.pins(channelId).then(
      ({ messages }) => !cancelled && (setPins(messages), setError(null)),
      (err: unknown) => !cancelled && setError(errorText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [channelId, pinCount]);
  const canUnpin = !channel?.archived && role !== "guest";

  return (
    <Modal title={`Pinned in ${title}`} width="lg" onClose={onClose}>
      <div className="-mx-5 -my-4" data-pinned-panel>
        {error ? (
          <p role="alert" className="px-5 py-6 text-sm text-ink-secondary">
            Couldn&apos;t load the pinned messages: {error}
          </p>
        ) : !pins ? (
          <p className="px-5 py-6 text-sm text-ink-secondary" aria-busy="true">
            Loading…
          </p>
        ) : pins.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <PinIcon className="mx-auto text-3xl text-ink-secondary" aria-hidden="true" />
            <p className="mt-2 font-semibold text-ink">Nothing pinned yet</p>
            <p className="mt-1 text-sm text-ink-secondary">
              Pin important messages from their menu (right-click, or the 📌 when you hover one) and
              they show up here for everyone.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {pins.map((m) => (
              <li key={m.sk} className="px-5 py-3" data-pin={m.messageId}>
                <div className="flex items-center gap-2">
                  <Avatar name={nameOf(m.userId, m.userEmail)} size="sm" mine={m.userId === me} />
                  <span className="min-w-0 truncate text-sm font-semibold text-ink">
                    {nameOf(m.userId, m.userEmail)}
                  </span>
                  <span className="shrink-0 text-xs text-ink-secondary">{when(m.createdAt)}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <JumpButton
                      onClick={() =>
                        onJump({ channelId: m.channelId, messageSk: m.sk, parentSk: m.parentSk })
                      }
                    />
                    {canUnpin && canPinMessage(m) && (
                      <button
                        type="button"
                        onClick={() => chat.pinMessage(m, false)}
                        className="rounded-lg p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
                        aria-label="Unpin"
                        title="Unpin"
                      >
                        <PinOffIcon />
                      </button>
                    )}
                  </span>
                </div>
                {m.text && (
                  <div
                    className="md mt-1.5 line-clamp-4 break-words text-sm leading-relaxed text-ink"
                    // Safe: renderMarkdown escapes all HTML before adding its own tags.
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
                  />
                )}
                {m.attachments.length > 0 && (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-secondary">
                    <FileIcon aria-hidden="true" />
                    {m.attachments.length === 1
                      ? m.attachments[0]!.name
                      : `${m.attachments.length} files`}
                  </p>
                )}
                {m.pinnedBy && (
                  <p className="mt-1 text-xs text-ink-secondary">
                    Pinned by {nameOf(m.pinnedBy)}
                    {m.pinnedAt ? ` · ${when(m.pinnedAt)}` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// --- Conversation details --------------------------------------------------------------

export type DetailsTab = "about" | "members" | "media";

export function ConversationDetailsModal({
  channelId,
  title,
  initialTab,
  onClose,
  onJump,
  onEdit,
}: Readonly<{
  channelId: string;
  title: string;
  initialTab?: DetailsTab;
  onClose: () => void;
  onJump: (target: JumpTarget) => void;
  /** Opens the channel's edit form (its creator or an admin). */
  onEdit: () => void;
}>) {
  const channel = useChat((s) => s.channels.find((c) => c.channelId === channelId));
  const dm = isDmChannel(channelId);
  const tabs: Array<{ id: DetailsTab; label: string }> = [
    ...(dm ? [] : [{ id: "about" as const, label: "About" }]),
    { id: "members", label: "Members" },
    { id: "media", label: "Files & Links" },
  ];
  const [tab, setTab] = useState<DetailsTab>(
    initialTab && tabs.some((t) => t.id === initialTab) ? initialTab : tabs[0]!.id,
  );
  return (
    <Modal title={title} width="lg" onClose={onClose}>
      <div className="-mx-5 -mt-4" data-details>
        <div
          role="tablist"
          aria-label="Conversation details"
          className="sticky -top-4 z-10 flex gap-1 border-b border-white/10 bg-[rgb(30_33_38/0.35)] px-5 backdrop-blur-xl"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`details-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`details-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3 py-3 text-sm font-semibold transition-colors ${
                tab === t.id
                  ? "border-primary text-ink"
                  : "border-transparent text-ink-secondary hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`details-panel-${tab}`}
          aria-labelledby={`details-tab-${tab}`}
          className="p-6"
        >
          {tab === "about" && channel && <AboutTab channel={channel} onEdit={onEdit} />}
          {tab === "members" && (
            <MembersTab channelId={channelId} channel={channel} onOpened={onClose} />
          )}
          {tab === "media" && <FilesAndLinks channelId={channelId} onJump={onJump} />}
        </div>
      </div>
    </Modal>
  );
}

function AboutTab({ channel, onEdit }: Readonly<{ channel: Channel; onEdit: () => void }>) {
  const me = useChat((s) => s.me);
  const nameOf = useNameOf();
  const canEdit = !!me && canEditChannel(channel, me.userId, me.role);
  // A quiet label over a readable value, with room between the fields.
  const row = (label: string, value: ReactNode) => (
    <div className="flex flex-col gap-1.5">
      <dt className="text-xs font-medium uppercase tracking-wider text-ink-secondary">{label}</dt>
      <dd className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">
        {value}
      </dd>
    </div>
  );
  return (
    <div className="flex flex-col gap-8" data-about>
      <dl className="space-y-6">
        {row("Topic", channel.topic || <span className="text-ink-secondary">No topic yet.</span>)}
        {row(
          "Description",
          channel.description || <span className="text-ink-secondary">No description yet.</span>,
        )}
        {channel.createdBy &&
          row(
            "Created",
            `by ${nameOf(channel.createdBy)}${channel.createdAt > 1 ? ` · ${formatDay(channel.createdAt)}` : ""}`,
          )}
        {channel.archived && row("Status", "Archived: read-only.")}
      </dl>
      <div className="border-t border-white/10 pt-6">
        {canEdit ? (
          <button type="button" onClick={onEdit} className="btn-primary">
            <PencilIcon /> Edit channel
          </button>
        ) : (
          <p className="text-sm text-ink-secondary">
            Only the channel&apos;s creator or an admin can edit these.
          </p>
        )}
      </div>
    </div>
  );
}

function MembersTab({
  channelId,
  channel,
  onOpened,
}: Readonly<{ channelId: string; channel: Channel | undefined; onOpened: () => void }>) {
  const navigate = useNavigate();
  const me = useChat((s) => s.me);
  const users = useChat((s) => s.users);
  const online = useChat((s) => s.online);
  const nameOf = useNameOf();
  if (!me) return null;
  const peer = dmPeer(channelId, me.userId);
  // A public channel is everyone's; a private one and a DM list their members.
  const ids =
    peer !== null
      ? [...new Set([me.userId, peer])]
      : channel?.type === "private"
        ? (channel.members ?? [])
        : Object.keys(users);
  const sorted = [...ids].sort((a, b) =>
    a === me.userId ? -1 : b === me.userId ? 1 : nameOf(a).localeCompare(nameOf(b)),
  );
  return (
    <div>
      {channel?.type === "public" && (
        <p className="mb-3 text-sm text-ink-secondary">
          Public: everyone in MindfulTech can read and write here.
        </p>
      )}
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        {sorted.length} {sorted.length === 1 ? "person" : "people"}
      </p>
      <ul className="-mx-2" aria-label="Members">
        {sorted.map((userId) => {
          const isMe = userId === me.userId;
          const isOnline = isMe || !!online[userId];
          return (
            <li key={userId}>
              <button
                type="button"
                disabled={isMe}
                onClick={() => {
                  onOpened();
                  navigate(`/app/${dmChannelId(me.userId, userId)}`);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left enabled:hover:bg-surface-hover"
                title={isMe ? undefined : `Message ${nameOf(userId)}`}
              >
                <span className="relative inline-flex">
                  <Avatar name={nameOf(userId)} mine={isMe} size="md" />
                  <PresenceDot online={isOnline} overlay />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {nameOf(userId)}
                    {isMe && <span className="font-normal text-ink-secondary"> (you)</span>}
                  </span>
                  <span className="block truncate text-xs text-ink-secondary">
                    {users[userId]?.email ?? ""}
                  </span>
                </span>
                <span className="text-xs text-ink-secondary">{isOnline ? "Active" : "Away"}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- Files & Links ----------------------------------------------------------------------

interface PagedList<T> {
  items: T[];
  cursor: string | null;
  status: "loading" | "ready" | "error";
  error: string | null;
}

/** One kind's pages: the first on mount, the next on "Show more". */
function usePaged<T>(
  channelId: string,
  fetchPage: (
    channelId: string,
    cursor?: string | null,
  ) => Promise<{ items: T[]; nextCursor: string | null }>,
) {
  const [list, setList] = useState<PagedList<T>>({
    items: [],
    cursor: null,
    status: "loading",
    error: null,
  });
  const load = useCallback(
    (cursor: string | null) => {
      setList((l) => ({ ...l, status: "loading", error: null }));
      fetchPage(channelId, cursor).then(
        ({ items, nextCursor }) =>
          setList((l) => ({
            items: cursor ? [...l.items, ...items] : items,
            cursor: nextCursor,
            status: "ready",
            error: null,
          })),
        (err: unknown) => setList((l) => ({ ...l, status: "error", error: errorText(err) })),
      );
    },
    [channelId, fetchPage],
  );
  useEffect(() => load(null), [load]);
  return { ...list, more: () => list.cursor && load(list.cursor), retry: () => load(list.cursor) };
}

const fetchFiles = (channelId: string, cursor?: string | null) =>
  mediaApi.files(channelId, cursor).then((p) => ({ items: p.files, nextCursor: p.nextCursor }));
const fetchLinks = (channelId: string, cursor?: string | null) =>
  mediaApi.links(channelId, cursor).then((p) => ({ items: p.links, nextCursor: p.nextCursor }));

export function FilesAndLinks({
  channelId,
  onJump,
}: Readonly<{ channelId: string; onJump: (target: JumpTarget) => void }>) {
  const files = usePaged(channelId, fetchFiles);
  const links = usePaged(channelId, fetchLinks);
  return (
    <div className="space-y-6" data-files-links>
      <MediaSection title="Recent files" list={files} empty="No files shared here yet.">
        {files.items.map((f) => (
          <FileRow key={`${f.messageId}-${f.attachment.key}`} file={f} onJump={onJump} />
        ))}
      </MediaSection>
      <MediaSection title="Links" list={links} empty="No links shared here yet.">
        {links.items.map((l, i) => (
          <LinkRow key={`${l.messageId}-${i}-${l.url}`} link={l} onJump={onJump} />
        ))}
      </MediaSection>
    </div>
  );
}

function MediaSection<T>({
  title,
  list,
  empty,
  children,
}: Readonly<{
  title: string;
  list: PagedList<T> & { more: () => void; retry: () => void };
  empty: string;
  children: ReactNode;
}>) {
  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        {title}
      </h3>
      {list.items.length > 0 && <ul className="-mx-2 space-y-0.5">{children}</ul>}
      {list.status === "ready" && list.items.length === 0 && (
        <p className="text-sm text-ink-secondary">{empty}</p>
      )}
      {list.status === "loading" && (
        <p className="py-2 text-sm text-ink-secondary" aria-busy="true">
          Loading…
        </p>
      )}
      {list.status === "error" && (
        <p role="alert" className="flex items-center gap-2 py-2 text-sm text-ink-secondary">
          Couldn&apos;t load: {list.error}
          <button type="button" onClick={list.retry} className="font-semibold text-primary">
            Try again
          </button>
        </p>
      )}
      {list.status === "ready" && list.cursor && (
        <button
          type="button"
          onClick={list.more}
          className="mt-2 rounded-lg px-2 py-1 text-sm font-semibold text-primary hover:bg-primary/15"
        >
          Show more
        </button>
      )}
    </section>
  );
}

const KIND_BADGE: Record<string, string> = {
  pdf: "PDF",
  audio: "AUDIO",
  video: "VIDEO",
  markdown: "MD",
};

function FileRow({
  file,
  onJump,
}: Readonly<{ file: ChannelFile; onJump: (target: JumpTarget) => void }>) {
  const nameOf = useNameOf();
  const showToast = useChat((s) => s.showToast);
  const a = file.attachment;
  const kind = attachmentKind(a);
  const [viewing, setViewing] = useState<"image" | "pdf" | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const thumb = a.thumbUrl ?? a.url;

  async function open() {
    if (kind === "pdf") return setViewing("pdf");
    if (kind === "image") {
      try {
        setImageUrl(await getDownloadUrl(a.key, a.url));
        setViewing("image");
      } catch (err) {
        showToast(errorText(err));
      }
      return;
    }
    // Audio, video and anything else: in a tab (the browser plays or downloads it).
    await downloadAttachment(a, showToast);
  }

  return (
    <li className="flex items-center gap-1 rounded-lg pr-1 hover:bg-surface-hover" data-file>
      <button
        type="button"
        onClick={() => void open()}
        className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left"
        title={`Open ${a.name}`}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sky/20 text-[10px] font-bold text-ink">
          {kind === "image" && thumb ? (
            <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : kind in KIND_BADGE ? (
            KIND_BADGE[kind]
          ) : (
            <FileIcon className="text-base" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{a.name}</span>
          <span className="block truncate text-xs text-ink-secondary">
            {formatBytes(a.size)} · {nameOf(file.userId)} · {when(file.createdAt)}
          </span>
        </span>
      </button>
      <JumpButton onClick={() => onJump(file)} />
      {viewing === "image" && imageUrl && (
        <Lightbox src={imageUrl} name={a.name} onClose={() => setViewing(null)} />
      )}
      {viewing === "pdf" && (
        <PdfViewer fileKey={a.key} name={a.name} onClose={() => setViewing(null)} />
      )}
    </li>
  );
}

/** The desktop app: the system browser (an `<a target="_blank">` would stay inside the app). */
function openInBrowser(e: MouseEvent<HTMLAnchorElement>, url: string) {
  if (!isDesktopApp()) return;
  e.preventDefault();
  void openExternal(url);
}

function LinkRow({
  link,
  onJump,
}: Readonly<{ link: ChannelLink; onJump: (target: JumpTarget) => void }>) {
  const nameOf = useNameOf();
  return (
    <li className="flex items-center gap-1 rounded-lg pr-1 hover:bg-surface-hover" data-link>
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => openInBrowser(e, link.url)}
        className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2"
      >
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-base font-bold uppercase text-primary"
          aria-hidden="true"
        >
          {link.domain.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-sm font-medium text-ink">
            <span className="truncate">{link.domain}</span>
            <ExternalLinkIcon className="shrink-0 text-xs text-ink-secondary" aria-hidden="true" />
          </span>
          <span className="block truncate text-xs text-primary">{link.url}</span>
          <span className="block truncate text-xs text-ink-secondary">
            {nameOf(link.userId)} · {when(link.createdAt)}
            {link.snippet && link.snippet !== link.url ? ` · ${link.snippet}` : ""}
          </span>
        </span>
      </a>
      <JumpButton onClick={() => onJump(link)} />
    </li>
  );
}
