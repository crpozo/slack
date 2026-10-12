import { HeadObjectCommand, NotFound, S3Client } from "@aws-sdk/client-s3";
import { MAX_ATTACHMENT_SIZE, type PresignResultEvent } from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler, sanitizeFileName } from "../src/handlers/presign";
import { resetMocks, sentEvents, wsEvent } from "./helpers";

const put = (overrides: object = {}) =>
  handler(
    wsEvent("presign", {
      action: "presign",
      op: "put",
      requestId: "r1",
      channelId: "ch_general",
      name: "mi foto.png",
      contentType: "image/png",
      size: 5 * 1024 * 1024,
      ...overrides,
    }),
  );

const s3Mock = mockClient(S3Client);

describe("presign", () => {
  beforeEach(() => {
    resetMocks();
    s3Mock.reset();
    s3Mock.on(HeadObjectCommand).resolves({});
  });

  it("put returns a signed PUT URL bound to type and size", async () => {
    const result = await put();

    expect(result.statusCode).toBe(200);
    const [[connectionId, event]] = sentEvents() as [[string, PresignResultEvent]];
    expect(connectionId).toBe("conn-alice");
    expect(event).toMatchObject({ type: "presign.result", requestId: "r1" });
    expect(event.key).toMatch(/^attachments\/ch_general\/[0-9A-Z]{26}-mi_foto\.png$/);
    const url = new URL(event.url);
    expect(url.hostname).toBe("slack-test-attachments.s3.us-east-1.amazonaws.com");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
  });

  it("put rejects files over 25 MB", async () => {
    const result = await put({ size: MAX_ATTACHMENT_SIZE + 1 });
    expect(result.statusCode).toBe(400);
    expect(sentEvents()[0]?.[1]).toMatchObject({ type: "error", code: "BAD_REQUEST" });
  });

  it("put refuses DMs the caller is not part of", async () => {
    const result = await put({ channelId: "dm_user-x_user-y" });
    expect(result.statusCode).toBe(400);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "CHANNEL_NOT_FOUND", requestId: "r1" });
  });

  it("get returns a signed GET URL", async () => {
    const key = "attachments/ch_general/01ABC-foto.png";
    const result = await handler(
      wsEvent("presign", { action: "presign", op: "get", requestId: "r2", key }),
    );

    expect(result.statusCode).toBe(200);
    const [[, event]] = sentEvents() as [[string, PresignResultEvent]];
    expect(event).toMatchObject({ type: "presign.result", key, requestId: "r2" });
    expect(new URL(event.url).pathname).toBe(`/${key}`);
  });

  it("get answers FILE_NOT_FOUND for a key that does not exist", async () => {
    s3Mock.on(HeadObjectCommand).rejects(new NotFound({ message: "missing", $metadata: {} }));
    const key = "attachments/ch_general/01ABC-borrado.png";

    const result = await handler(
      wsEvent("presign", { action: "presign", op: "get", requestId: "r3", key }),
    );

    expect(result.statusCode).toBe(400);
    expect(s3Mock.commandCalls(HeadObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: "slack-test-attachments",
      Key: key,
    });
    expect(sentEvents()).toEqual([
      ["conn-alice", { type: "error", code: "FILE_NOT_FOUND", requestId: "r3" }],
    ]);
  });

  it("get surfaces unexpected S3 errors as INTERNAL_ERROR", async () => {
    s3Mock.on(HeadObjectCommand).rejects(new Error("throttled"));
    const result = await handler(
      wsEvent("presign", {
        action: "presign",
        op: "get",
        requestId: "r4",
        key: "attachments/ch_general/x.png",
      }),
    );
    expect(result.statusCode).toBe(500);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("get rejects keys outside attachments/ or with traversal", async () => {
    for (const key of ["other/secret.txt", "attachments/../x", "attachments/ch_general"]) {
      const result = await handler(
        wsEvent("presign", { action: "presign", op: "get", requestId: "r", key }),
      );
      expect(result.statusCode, key).toBe(400);
    }
  });

  it("sanitizes file names", () => {
    expect(sanitizeFileName("Informe final (v2).pdf")).toBe("Informe_final__v2_.pdf");
    expect(sanitizeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeFileName("ñ")).toBe("_");
    expect(sanitizeFileName("...")).toBe("file");
  });
});
