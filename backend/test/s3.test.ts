import { PRESIGN_GET_WINDOW_SECONDS, type Attachment } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import {
  attachmentDisposition,
  presignDownload,
  presignGet,
  signAttachments,
  signingWindowStart,
  withSignedUrls,
} from "../src/lib/s3";

const WINDOW_MS = PRESIGN_GET_WINDOW_SECONDS * 1000;
const T0 = Date.UTC(2026, 10, 3, 14, 0); // 14:00Z: on a 2-hour boundary
const image: Attachment = {
  key: "attachments/ch_general/01A-photo.jpg",
  name: "photo.jpg",
  size: 10,
  contentType: "image/jpeg",
  thumbKey: "attachments/ch_general/01A-thumb-photo.webp",
  width: 1280,
  height: 960,
};
const pdf: Attachment = {
  key: "attachments/ch_general/01B-spec.pdf",
  name: "spec.pdf",
  size: 10,
  contentType: "application/pdf",
};

describe("download URLs", () => {
  it("are signed as of the start of a 2-hour window and stay valid an hour past it", async () => {
    expect(signingWindowStart(T0 + 1).getTime()).toBe(T0);
    expect(signingWindowStart(T0 + WINDOW_MS - 1).getTime()).toBe(T0);
    expect(signingWindowStart(T0 + WINDOW_MS).getTime()).toBe(T0 + WINDOW_MS);

    const early = new URL(await presignGet(image.key, T0 + 60_000));
    const late = new URL(await presignGet(image.key, T0 + WINDOW_MS - 60_000));
    const next = new URL(await presignGet(image.key, T0 + WINDOW_MS + 60_000));
    // Identical within the window (the browser cache key), different in the next one.
    expect(early.href).toBe(late.href);
    expect(next.href).not.toBe(early.href);
    expect(early.searchParams.get("X-Amz-Date")).toBe("20261103T140000Z");
    expect(early.searchParams.get("X-Amz-Expires")).toBe(String(3 * 3600));
    expect(early.pathname).toBe(`/${image.key}`);
  });

  it("are attached to image, audio and video attachments only, thumbnails included", async () => {
    const signed = await withSignedUrls(image, T0);
    expect(signed.url).toMatch(/01A-photo\.jpg\?/);
    expect(signed.thumbUrl).toMatch(/01A-thumb-photo\.webp\?/);
    expect(signed).toMatchObject({ width: 1280, height: 960 });
    expect(await withSignedUrls(pdf, T0)).toBe(pdf);
    const video = { ...pdf, key: "attachments/ch_general/01C-demo.mp4", contentType: "video/mp4" };
    expect((await withSignedUrls(video, T0)).url).toMatch(/01C-demo\.mp4\?/);

    const message = await signAttachments(
      {
        messageId: "m1",
        channelId: "ch_general",
        sk: "1#m1",
        userId: "u1",
        userEmail: "u1@example.com",
        text: "",
        attachments: [pdf, { ...image, thumbKey: undefined }],
        createdAt: 1,
        reactions: {},
      },
      T0,
    );
    expect(message.attachments[0]).toBe(pdf);
    expect(message.attachments[1]?.url).toBeDefined();
    expect(message.attachments[1]?.thumbUrl).toBeUndefined();
  });
});

describe("download links that save (Phase 47)", () => {
  it("names the file in an attachment disposition, ASCII and UTF-8, with nothing left unescaped", () => {
    expect(attachmentDisposition("GUIA_GITHUB_ADMIN.md")).toBe(
      "attachment; filename=\"GUIA_GITHUB_ADMIN.md\"; filename*=UTF-8''GUIA_GITHUB_ADMIN.md",
    );
    expect(attachmentDisposition("Cotización (final).pdf")).toBe(
      "attachment; filename=\"Cotizaci_n (final).pdf\"; filename*=UTF-8''Cotizaci%C3%B3n%20%28final%29.pdf",
    );
    // A quote, a backslash or a line break can't end the header early.
    const tricky = attachmentDisposition('a"b\\c\r\nSet-Cookie: x.txt');
    expect(tricky).not.toMatch(/[\r\n]/);
    expect(tricky.split('"')).toHaveLength(3);
  });

  it("signs the disposition into the URL, in the same windows as inline links", async () => {
    const url = new URL(await presignDownload(pdf.key, "spec.pdf", T0 + 60_000));
    expect(url.pathname).toBe(`/${pdf.key}`);
    expect(url.searchParams.get("response-content-disposition")).toBe(
      "attachment; filename=\"spec.pdf\"; filename*=UTF-8''spec.pdf",
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe(
      new URL(await presignGet(pdf.key, T0 + 60_000)).searchParams.get("X-Amz-Date"),
    );
  });
});
