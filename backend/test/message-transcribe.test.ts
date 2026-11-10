import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { MAX_TRANSCRIBE_BYTES, type Message } from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, TRANSCRIBE_HOLD_MS, useSpeechToText } from "../src/handlers/message-transcribe";
import type { HttpEvent } from "../src/lib/http";
import { toWireMessage } from "../src/lib/messages";
import { resetOpenAiKey } from "../src/lib/openai";
import type { SpeechToText, WhisperResult } from "../src/lib/whisper";
import { applyUpdate, evaluateCondition } from "./fakeExpressions";
import { ALICE, BOB, ddbMock, dmRow, mockChannels, privateRow, resetMocks } from "./helpers";

// Phase 58: a voice message's transcript, on demand, kept on the message.
// DynamoDB is an in-memory table (conditions and updates evaluated), S3 and
// Whisper are mocks: what's checked is that OpenAI is called once per message.

const s3Mock = mockClient(S3Client);
const CAROL = { userId: "user-carol", email: "carol@example.com" };
const DM = dmRow(ALICE.userId, BOB.userId);
const TEAM = privateRow("ch_team", ALICE.userId, [ALICE.userId, BOB.userId]);
const KEY = `attachments/${DM.channelId}/01J/voice-note.webm`;
const AUDIO = Buffer.from("OggS fake opus audio");
const NOW = Date.parse("2026-11-10T15:00:00Z");

type Row = Record<string, unknown>;
let rows: Map<string, Row>;
const rowKey = (k: { channelId?: unknown; sk?: unknown }) =>
  `${String(k.channelId)}|${String(k.sk)}`;

const voiceNote = (patch: Partial<Message> = {}): Message => ({
  messageId: "01JVOICE",
  channelId: DM.channelId,
  sk: "1762786800000#01JVOICE",
  userId: BOB.userId,
  userEmail: BOB.email,
  text: "",
  attachments: [
    {
      key: KEY,
      name: "voice-note.webm",
      size: AUDIO.length,
      contentType: "audio/webm;codecs=opus",
      durationMs: 7_000,
    },
  ],
  createdAt: 1_762_786_800_000,
  ...patch,
});

const whisperSaid = (text: string, extra: Partial<WhisperResult> = {}): WhisperResult => ({
  text,
  duration: 7,
  segments: [
    {
      id: 0,
      seek: 0,
      start: 0,
      end: 7,
      text,
      tokens: [],
      temperature: 0,
      avg_logprob: -0.2,
      compression_ratio: 1.2,
      no_speech_prob: 0.01,
    },
  ],
  ...extra,
});

let transcribe: ReturnType<typeof vi.fn<SpeechToText["transcribe"]>>;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  resetMocks();
  s3Mock.reset();
  mockChannels(DM, TEAM);
  rows = new Map([[rowKey(voiceNote()), { ...voiceNote() }]]);
  ddbMock.on(GetCommand, { TableName: "slack-test-messages" }).callsFake(({ Key }) => ({
    Item: rows.get(rowKey(Key)) && { ...rows.get(rowKey(Key)) },
  }));
  ddbMock.on(UpdateCommand, { TableName: "slack-test-messages" }).callsFake((input) => {
    const k = rowKey(input.Key);
    const row = rows.get(k);
    const values = input.ExpressionAttributeValues ?? {};
    if (!evaluateCondition(input.ConditionExpression, row, values)) {
      throw new ConditionalCheckFailedException({ message: "condition", $metadata: {} });
    }
    rows.set(k, applyUpdate(row ?? { ...input.Key }, input.UpdateExpression, values));
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake(() => ({
    ContentLength: AUDIO.length,
    Body: { transformToByteArray: async () => new Uint8Array(AUDIO) },
  }));
  transcribe = vi.fn<SpeechToText["transcribe"]>(async () =>
    whisperSaid("Oye, el deploy de staging ya está listo, revisa el pull request."),
  );
  useSpeechToText({ transcribe });
});
afterEach(() => {
  vi.useRealTimers();
  useSpeechToText(null);
});

function request(
  { channelId = DM.channelId, sk = voiceNote().sk } = {},
  user: { userId: string; email: string } = ALICE,
): HttpEvent {
  return {
    version: "2.0",
    routeKey: "POST /messages/{channelId}/{sk}/transcribe",
    rawPath: `/messages/${encodeURIComponent(channelId)}/${encodeURIComponent(sk)}/transcribe`,
    headers: {},
    pathParameters: { channelId: encodeURIComponent(channelId), sk: encodeURIComponent(sk) },
    isBase64Encoded: false,
    requestContext: {
      http: { method: "POST", path: "/messages/x/y/transcribe" },
      authorizer: { jwt: { claims: { sub: user.userId, email: user.email }, scopes: [] } },
    },
  } as unknown as HttpEvent;
}

const call = async (...args: Parameters<typeof request>) => {
  const result = (await handler(request(...args))) as { statusCode: number; body: string };
  return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : undefined };
};
const stored = (sk = voiceNote().sk, channelId = DM.channelId) =>
  rows.get(rowKey({ channelId, sk }));

describe("POST /messages/{channelId}/{sk}/transcribe (Phase 58)", () => {
  it("fetches the audio from S3, sends the buffer to Whisper, keeps the text and returns it", async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toEqual({
      transcript: "Oye, el deploy de staging ya está listo, revisa el pull request.",
      cached: false,
    });
    // b. The message's own file, read from the attachments bucket.
    expect(s3Mock.commandCalls(GetObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: "slack-test-attachments",
      Key: KEY,
    });
    // c. The bytes themselves, named so Whisper knows the format.
    expect(transcribe).toHaveBeenCalledTimes(1);
    const [buffer, fileName, contentType] = transcribe.mock.calls[0]!;
    expect(Buffer.isBuffer(buffer) && buffer.equals(AUDIO)).toBe(true);
    expect(fileName).toBe("voice.webm");
    expect(contentType).toBe("audio/webm;codecs=opus");
    // d. Kept on the message; the hold is gone.
    expect(stored()).toMatchObject({ transcript: body.transcript });
    expect(stored()).not.toHaveProperty("transcribingAt");
  });

  it("answers from DynamoDB afterwards: no second S3 read, no second OpenAI call", async () => {
    await call();
    const again = await call({}, BOB);
    expect(again).toEqual({
      status: 200,
      body: {
        transcript: "Oye, el deploy de staging ya está listo, revisa el pull request.",
        cached: true,
      },
    });
    expect(await call()).toMatchObject({ body: { cached: true } });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
  });

  it("returns a transcript already on the message at once", async () => {
    rows.set(rowKey(voiceNote()), { ...voiceNote(), transcript: "Ya transcrito." });
    expect(await call()).toEqual({
      status: 200,
      body: { transcript: "Ya transcrito.", cached: true },
    });
    expect(transcribe).not.toHaveBeenCalled();
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it("calls OpenAI once when two people click at the same time", async () => {
    let finish!: (r: WhisperResult) => void;
    transcribe.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const first = call({}, ALICE);
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    // Bob asks while Alice's request is still at Whisper: told to try again shortly.
    const second = await call({}, BOB);
    expect(second.status).toBe(409);
    finish(whisperSaid("Listo."));
    expect((await first).body).toEqual({ transcript: "Listo.", cached: false });
    // His retry reads what hers kept.
    expect(await call({}, BOB)).toMatchObject({ body: { transcript: "Listo.", cached: true } });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("takes over a hold left by a request that died", async () => {
    rows.set(rowKey(voiceNote()), {
      ...voiceNote(),
      transcribingAt: NOW - TRANSCRIBE_HOLD_MS - 1,
    });
    expect((await call()).status).toBe(200);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("gives the hold back when Whisper fails, so a retry works at once", async () => {
    transcribe.mockRejectedValueOnce(new Error("OpenAI 500"));
    const failed = await call();
    expect(failed.status).toBe(502);
    expect(stored()).not.toHaveProperty("transcribingAt");
    expect(stored()).not.toHaveProperty("transcript");
    expect((await call()).body).toMatchObject({ cached: false });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("keeps an empty transcript when nothing was said, and drops Whisper's filler", async () => {
    transcribe.mockResolvedValueOnce(
      whisperSaid("Subtítulos realizados por la comunidad de Amara.org"),
    );
    expect((await call()).body).toEqual({ transcript: "", cached: false });
    expect(stored()?.transcript).toBe("");
    expect((await call()).body).toEqual({ transcript: "", cached: true });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("transcribes a voice reply in a thread (its key has a '#' in it)", async () => {
    const reply = voiceNote({ sk: "thread#1762786800000#01JPARENT#1762786900000#01JREPLY" });
    rows.set(rowKey(reply), { ...reply });
    expect((await call({ sk: reply.sk })).status).toBe(200);
    expect(stored(reply.sk)?.transcript).toMatch(/deploy de staging/);
  });

  it("refuses people outside the conversation, as if it didn't exist", async () => {
    const res = await call({}, CAROL);
    expect(res.status).toBe(404);
    expect(transcribe).not.toHaveBeenCalled();
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it("refuses a message without audio, a deleted one, and one too large", async () => {
    const text = voiceNote({ sk: "2#text", attachments: [] });
    rows.set(rowKey(text), { ...text });
    expect((await call({ sk: text.sk })).status).toBe(400);

    rows.set(rowKey(voiceNote()), { ...voiceNote(), deletedAt: NOW });
    expect((await call()).status).toBe(404);

    const big = voiceNote({
      sk: "3#big",
      attachments: [{ ...voiceNote().attachments[0]!, size: MAX_TRANSCRIBE_BYTES + 1 }],
    });
    rows.set(rowKey(big), { ...big });
    expect((await call({ sk: big.sk })).status).toBe(413);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("works in a private channel for its members", async () => {
    const note = voiceNote({ channelId: TEAM.channelId });
    rows.set(rowKey(note), { ...note });
    expect((await call({ channelId: TEAM.channelId }, BOB)).status).toBe(200);
    expect(stored(note.sk, TEAM.channelId)?.transcript).toBeTruthy();
  });

  it("answers 503 when no OpenAI key is configured", async () => {
    useSpeechToText(null);
    resetOpenAiKey();
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY_PARAMETER;
    try {
      expect((await call()).status).toBe(503);
      expect(stored()).not.toHaveProperty("transcribingAt");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      resetOpenAiKey();
    }
  });

  it("never sends the server's hold to clients", () => {
    const wire = toWireMessage({ ...voiceNote(), transcribingAt: NOW, transcript: "Hola" });
    expect(wire).not.toHaveProperty("transcribingAt");
    expect(wire.transcript).toBe("Hola");
  });
});
