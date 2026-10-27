import type { Attachment } from "@mindfultech/shared";
import { useSyncExternalStore } from "react";
import { useChat, type ChatMessage } from "../store";
import { isDesktopApp } from "./desktop";

// ---------------------------------------------------------------------------
// The outbox (Phase 39): sending never blocks the composer. A message shows at
// once (optimistic, `status: "pending"`) while its files finish uploading in
// the background; then it goes out. Messages of one conversation go out
// strictly in the order they were sent: each waits for the previous one to be
// confirmed by the server (`message.new` with its `clientId`) or to fail.
// Uploads still run in parallel, from the moment a file is attached.
// ---------------------------------------------------------------------------

export interface UploadState {
  /** 0–1. */
  progress: number;
  attachment?: Attachment;
  error?: string;
}

/**
 * One file going up: started when it's attached to the composer, awaited by
 * the outbox when its message is sent, started again by a retry if it failed.
 */
export class UploadTask {
  readonly id = crypto.randomUUID();
  /** A local copy to show while it uploads (images only), `blob:` URL. */
  readonly previewUrl: string | null;
  private current: UploadState = { progress: 0 };
  private running: Promise<Attachment> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly file: File,
    private readonly upload: (onProgress: (fraction: number) => void) => Promise<Attachment>,
    /** Fields the message's attachment gets on top of the upload's (a voice note's length). */
    readonly extra: Partial<Attachment> = {},
  ) {
    this.previewUrl =
      file.type.startsWith("image/") && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file)
        : null;
    void this.start().catch(() => {});
  }

  get state(): UploadState {
    return this.current;
  }

  /** Uploads, or joins the upload going on; resolves at once when it's already up. */
  start(): Promise<Attachment> {
    if (this.current.attachment) return Promise.resolve(this.current.attachment);
    if (this.running) return this.running;
    this.set({ progress: 0 });
    this.running = this.upload((progress) => this.set({ ...this.current, progress })).then(
      (uploaded) => {
        const attachment = { ...uploaded, ...this.extra };
        this.running = null;
        this.set({ progress: 1, attachment });
        return attachment;
      },
      (err: unknown) => {
        this.running = null;
        this.set({ progress: 0, error: err instanceof Error ? err.message : "Upload failed" });
        throw err;
      },
    );
    return this.running;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** No longer shown anywhere: frees the local copy. */
  dispose(): void {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
  }

  private set(state: UploadState): void {
    this.current = state;
    this.listeners.forEach((fn) => fn());
  }
}

/** A file's upload as it goes (progress, done, failed), for the chip or bubble showing it. */
export function useUploadState(task: UploadTask): UploadState {
  return useSyncExternalStore(task.subscribe, () => task.state);
}

// --- Local previews, so a confirmed image doesn't blink ------------------------------
//
// When a message is confirmed its pending copy is replaced by the server's, whose
// images load from S3. Until they have, the image shows the local copy it was
// sent from, looked up by its S3 key (and its thumbnail's).

const previews = new Map<string, string>();
/** Enough for a burst of images; older ones give their memory back. */
const MAX_PREVIEWS = 60;

function revokeIfUnused(url: string): void {
  if (![...previews.values()].includes(url)) URL.revokeObjectURL(url);
}

/** The local copy an uploaded file was sent from, while its S3 image loads. */
export function localPreview(key: string): string | undefined {
  return previews.get(key);
}

/** The S3 image has loaded: the local copy is no longer needed. */
export function releaseLocalPreview(...keys: Array<string | undefined>): void {
  for (const key of keys) {
    if (!key) continue;
    const url = previews.get(key);
    if (!url) continue;
    previews.delete(key);
    revokeIfUnused(url);
  }
}

function keepPreview(attachment: Attachment, url: string): void {
  previews.set(attachment.key, url);
  if (attachment.thumbKey) previews.set(attachment.thumbKey, url);
  while (previews.size > MAX_PREVIEWS) {
    const [oldestKey, oldestUrl] = previews.entries().next().value as [string, string];
    previews.delete(oldestKey);
    revokeIfUnused(oldestUrl);
  }
}

// --- The queue -----------------------------------------------------------------------

interface Outgoing {
  message: ChatMessage;
  files: UploadTask[];
}

/** Sends a message whose files are up; resolves `true` once the server confirmed it. */
export type Deliver = (message: ChatMessage) => Promise<boolean>;

/** A conversation's lane: its top-level messages, or one thread's replies. */
const laneOf = (m: ChatMessage) => m.parentSk ?? m.channelId;

class Outbox {
  /** Every message not confirmed yet (pending or failed), by `clientId`. */
  private readonly items = new Map<string, Outgoing>();
  /** What each lane still has to send, in order. */
  private readonly lanes = new Map<string, string[]>();
  private readonly running = new Set<string>();
  private deliver: Deliver | null = null;
  private generation = 0;

  /** Wired by the chat service: how a message goes out once its files are up. */
  attach(deliver: Deliver): void {
    this.deliver = deliver;
  }

  /** Queues a pending message (already shown) with the files still going up. */
  enqueue(message: ChatMessage, files: UploadTask[]): void {
    if (!message.clientId) return;
    this.items.set(message.clientId, { message, files });
    this.push(message);
  }

  /** The files of a message not confirmed yet, for its bubble. */
  files(clientId: string | undefined): UploadTask[] {
    return (clientId && this.items.get(clientId)?.files) || [];
  }

  /** Whether `clientId` is still the outbox's (pending or failed). */
  has(clientId: string): boolean {
    return this.items.has(clientId);
  }

  /** Sends a failed message again (its failed files go up again), at the end of its lane. */
  retry(clientId: string): boolean {
    const item = this.items.get(clientId);
    if (!item) return false;
    useChat.getState().setPendingStatus(item.message.channelId, clientId, "pending");
    this.push(item.message);
    return true;
  }

  /**
   * The server stored it (`message.new`): the item leaves the outbox. Its files'
   * local copies stay with their S3 keys until the real images have loaded.
   */
  confirmed(clientId: string): void {
    const item = this.items.get(clientId);
    if (!item) return;
    this.items.delete(clientId);
    for (const file of item.files) {
      const { attachment } = file.state;
      if (attachment && file.previewUrl) keepPreview(attachment, file.previewUrl);
      else file.dispose();
    }
  }

  /** Something is still on its way: leaving the page now would lose it. */
  get sending(): boolean {
    return [...this.lanes.values()].some((queue) => queue.length > 0);
  }

  /** Signed out: everything not sent is dropped, local copies are freed. */
  clear(): void {
    this.generation++;
    for (const item of this.items.values()) item.files.forEach((f) => f.dispose());
    this.items.clear();
    this.lanes.clear();
    this.running.clear();
    for (const url of new Set(previews.values())) URL.revokeObjectURL(url);
    previews.clear();
  }

  private push(message: ChatMessage): void {
    const lane = laneOf(message);
    const queue = this.lanes.get(lane) ?? [];
    if (!queue.includes(message.clientId!)) queue.push(message.clientId!);
    this.lanes.set(lane, queue);
    void this.pump(lane);
  }

  /** Sends the lane's messages one after the other. */
  private async pump(lane: string): Promise<void> {
    if (this.running.has(lane)) return;
    this.running.add(lane);
    const generation = this.generation;
    try {
      for (;;) {
        const clientId = this.lanes.get(lane)?.[0];
        if (!clientId) break;
        await this.send(clientId);
        if (generation !== this.generation) return;
        this.lanes.get(lane)?.shift();
      }
      this.lanes.delete(lane);
    } finally {
      if (generation === this.generation) this.running.delete(lane);
    }
  }

  private async send(clientId: string): Promise<void> {
    const item = this.items.get(clientId);
    if (!item) return; // confirmed meanwhile (a retry racing a late confirmation)
    const fail = () =>
      useChat.getState().setPendingStatus(item.message.channelId, clientId, "failed");
    let uploaded: Attachment[];
    try {
      uploaded = await Promise.all(item.files.map((f) => f.start()));
    } catch {
      fail(); // one file didn't go up; the next message goes on
      return;
    }
    if (!this.items.has(clientId) || !this.deliver) return;
    if (uploaded.length > 0) {
      // The pending copy now carries what the server will store (a retry resends it as is).
      item.message = { ...item.message, attachments: uploaded };
      useChat.getState().addPending({ ...item.message, status: "pending" });
    }
    await this.deliver(item.message);
  }
}

export const outbox = new Outbox();

// Leaving with something still on its way would lose it: the browser asks first.
// (Not in the desktop app, whose window close only hides it.)
if (typeof window !== "undefined" && !isDesktopApp()) {
  window.addEventListener("beforeunload", (e) => {
    if (!outbox.sending) return;
    e.preventDefault();
    e.returnValue = ""; // older browsers
  });
}
