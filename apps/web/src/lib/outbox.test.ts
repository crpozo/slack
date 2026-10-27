import type { Attachment } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat, type ChatMessage } from "../store";
import { pendingMessageId } from "../store/messages";
import { localPreview, outbox, releaseLocalPreview, UploadTask } from "./outbox";

/** A promise settled from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let n = 0;
function pending(text: string, channelId = "ch_general", parentSk?: string): ChatMessage {
  const clientId = `c${++n}`;
  const message: ChatMessage = {
    messageId: pendingMessageId(clientId),
    channelId,
    sk: "",
    userId: "me",
    userEmail: "me@example.com",
    text,
    attachments: [],
    createdAt: Date.now() + n,
    clientId,
    status: "pending",
    ...(parentSk && { parentId: "p", parentSk }),
  };
  useChat.getState().addPending(message);
  return message;
}

const statusOf = (m: ChatMessage) =>
  useChat.getState().messagesByChannel[m.channelId]?.find((x) => x.messageId === m.messageId)
    ?.status;

/** A file whose upload is settled by the test (each attempt has its own deferred). */
function controlledFile(name: string, type = "image/png") {
  const attempts: Array<ReturnType<typeof deferred<Attachment>>> = [];
  const task = new UploadTask(new File(["x"], name, { type }), () => {
    const d = deferred<Attachment>();
    attempts.push(d);
    return d.promise;
  });
  const done = (i = attempts.length - 1) =>
    attempts[i]!.resolve({ key: `attachments/ch/${name}`, name, size: 1, contentType: type });
  const fail = (i = attempts.length - 1) => attempts[i]!.reject(new Error("Upload failed"));
  return { task, attempts, done, fail };
}

describe("outbox", () => {
  let delivered: string[];
  let confirmNext: Array<(ok: boolean) => void>;

  beforeEach(() => {
    delivered = [];
    confirmNext = [];
    outbox.attach((message) => {
      delivered.push(message.text);
      return new Promise<boolean>((resolve) => confirmNext.push(resolve));
    });
    useChat.setState({ messagesByChannel: {}, threads: {} });
  });

  afterEach(() => outbox.clear());

  /** The server confirms the oldest message still waiting. */
  async function confirm(ok = true) {
    const settle = confirmNext.shift();
    settle?.(ok);
    await flush();
  }

  it("sends a text right away, the next one only once the first is confirmed", async () => {
    outbox.enqueue(pending("one"), []);
    outbox.enqueue(pending("two"), []);
    await flush();
    expect(delivered).toEqual(["one"]);
    expect(outbox.sending).toBe(true);
    await confirm();
    expect(delivered).toEqual(["one", "two"]);
    await confirm();
    expect(outbox.sending).toBe(false);
  });

  it("keeps a text sent after an image behind it until the image is up and sent", async () => {
    const image = controlledFile("photo.png");
    const withImage = pending("");
    outbox.enqueue(withImage, [image.task]);
    outbox.enqueue(pending("after"), []);
    await flush();
    expect(delivered).toEqual([]); // the text waits for the image

    image.done();
    await flush();
    expect(delivered).toEqual([""]);
    // The pending copy now carries the uploaded attachment (what a retry resends).
    const stored = useChat
      .getState()
      .messagesByChannel.ch_general!.find((m) => m.messageId === withImage.messageId)!;
    expect(stored.attachments.map((a) => a.key)).toEqual(["attachments/ch/photo.png"]);

    await confirm();
    expect(delivered).toEqual(["", "after"]);
  });

  it("uploads in parallel but sends in order", async () => {
    const big = controlledFile("big.png");
    const small = controlledFile("small.png");
    outbox.enqueue(pending("first"), [big.task]);
    outbox.enqueue(pending("second"), [small.task]);
    small.done(); // the second file finishes first
    await flush();
    expect(delivered).toEqual([]);
    big.done();
    await flush();
    expect(delivered).toEqual(["first"]);
    await confirm();
    expect(delivered).toEqual(["first", "second"]);
  });

  it("fails a message whose file didn't go up, goes on, and retries just that file", async () => {
    const ok = controlledFile("ok.png");
    const bad = controlledFile("bad.png");
    const failing = pending("with files");
    outbox.enqueue(failing, [ok.task, bad.task]);
    outbox.enqueue(pending("next"), []);
    ok.done();
    bad.fail();
    await flush();
    expect(statusOf(failing)).toBe("failed");
    expect(delivered).toEqual(["next"]); // not stuck behind the failure
    await confirm();

    expect(outbox.retry(failing.clientId!)).toBe(true);
    expect(statusOf(failing)).toBe("pending");
    await flush();
    expect(ok.attempts).toHaveLength(1); // already up: not sent again
    expect(bad.attempts).toHaveLength(2);
    bad.done();
    await flush();
    expect(delivered).toEqual(["next", "with files"]);
  });

  it("moves on when a message isn't confirmed in time", async () => {
    outbox.enqueue(pending("lost"), []);
    outbox.enqueue(pending("then"), []);
    await flush();
    await confirm(false); // timed out (chat marks it failed)
    expect(delivered).toEqual(["lost", "then"]);
  });

  it("keeps threads and channels in separate lanes", async () => {
    outbox.enqueue(pending("channel"), []);
    outbox.enqueue(pending("reply", "ch_general", "1700000000000#P"), []);
    await flush();
    expect(delivered).toEqual(["channel", "reply"]);
  });

  it("hands a confirmed image's local copy to its S3 key until the real one loads", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const image = controlledFile("pic.png");
    const message = pending("");
    outbox.enqueue(message, [image.task]);
    image.done();
    await flush();
    outbox.confirmed(message.clientId!);
    await confirm();
    expect(outbox.files(message.clientId)).toEqual([]);
    expect(localPreview("attachments/ch/pic.png")).toBe(image.task.previewUrl);
    expect(revoke).not.toHaveBeenCalledWith(image.task.previewUrl);

    releaseLocalPreview("attachments/ch/pic.png");
    expect(localPreview("attachments/ch/pic.png")).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith(image.task.previewUrl);
    revoke.mockRestore();
  });

  it("drops everything and frees the local copies on sign-out", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const image = controlledFile("left.png");
    const message = pending("");
    outbox.enqueue(message, [image.task]);
    outbox.clear();
    expect(outbox.sending).toBe(false);
    expect(outbox.has(message.clientId!)).toBe(false);
    expect(revoke).toHaveBeenCalledWith(image.task.previewUrl);
    image.done();
    await flush();
    expect(delivered).toEqual([]);
    revoke.mockRestore();
  });
});
