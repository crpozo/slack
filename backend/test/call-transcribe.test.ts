import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  dmChannelId,
  GENERAL_CHANNEL_ID,
  MAX_NOTES_CLIP_BYTES,
  MAX_NOTES_CLIPS,
  WHISPER_PROMPT,
} from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, useSpeechToText } from "../src/handlers/call-transcribe";
import type { HttpEvent } from "../src/lib/http";
import { openaiApiKey, resetOpenAiKey } from "../src/lib/openai";
import { clipLines, whisperOf, type WhisperResult } from "../src/lib/whisper";
import { ALICE, BOB, ddbMock, dmRow, GENERAL, mockChannels, resetMocks } from "./helpers";

const s3Mock = mockClient(S3Client);
const ssmMock = mockClient(SSMClient);
const CAROL = { userId: "user-carol", email: "carol@example.com" };
const DM = dmChannelId(ALICE.userId, BOB.userId);
const DETAILS = "slack-test-note-details";
const CALL = "01CALLCALLCALLCALLCALLCALL";
const NOW = 1_760_000_000_000;
const STARTED = NOW - 240_000;
const AUDIO = Buffer.from("OggS fake opus bytes");

const segment = (start: number, text: string, patch: Record<string, number> = {}) => ({
  id: 0,
  seek: 0,
  start,
  end: start + 4,
  text,
  tokens: [],
  temperature: 0,
  avg_logprob: -0.3,
  compression_ratio: 1.4,
  no_speech_prob: 0.02,
  ...patch,
});

const heard: WhisperResult = {
  text: "…",
  duration: 240,
  segments: [
    segment(1.5, " Hagamos el deploy del backend hoy."),
    segment(6, " Hagamos el deploy del backend hoy."), // Whisper stuttering
    segment(30, " mmm", { no_speech_prob: 0.9, avg_logprob: -1.4 }), // silence
    segment(60, " Revisa los endpoints del dashboard."),
    segment(200, " Subtítulos realizados por la comunidad de Amara.org"),
    segment(210, " ja ja ja ja ja ja ja ja ja ja", { compression_ratio: 3.1 }),
    segment(230, " ¡Gracias por ver el video!"),
  ],
};

function clipEvent(
  query: Record<string, string> = {},
  opts: { user?: typeof ALICE; body?: Buffer; contentType?: string; base64?: boolean } = {},
): HttpEvent {
  const user = opts.user ?? ALICE;
  const body = opts.body ?? AUDIO;
  return {
    version: "2.0",
    routeKey: "POST /calls/{callId}/clips",
    rawPath: `/calls/${CALL}/clips`,
    headers: { "content-type": opts.contentType ?? "audio/webm;codecs=opus" },
    queryStringParameters: {
      channelId: DM,
      speaker: BOB.userId,
      startedAt: String(STARTED),
      durationMs: "240000",
      ...query,
    },
    pathParameters: { callId: CALL },
    body: opts.base64 === false ? body.toString("utf8") : body.toString("base64"),
    isBase64Encoded: opts.base64 !== false,
    requestContext: {
      http: { method: "POST", path: `/calls/${CALL}/clips` },
      authorizer: { jwt: { claims: { sub: user.userId, email: user.email }, scopes: [] } },
    },
  } as unknown as HttpEvent;
}

const send = async (...args: Parameters<typeof clipEvent>) => {
  const result = (await handler(clipEvent(...args))) as { statusCode: number; body: string };
  return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : undefined };
};

describe("POST /calls/{callId}/clips (Phase 43, Whisper)", () => {
  let transcribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetMocks();
    s3Mock.reset();
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    mockChannels(GENERAL, dmRow(ALICE.userId, BOB.userId));
    ddbMock.on(GetCommand, { TableName: DETAILS }).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    transcribe = vi.fn(async () => heard);
    useSpeechToText({ transcribe });
  });
  afterEach(() => {
    useSpeechToText(null);
    vi.useRealTimers();
  });

  it("transcribes the clip from memory and keeps only the text worth keeping", async () => {
    const { status, body } = await send();
    expect(status).toBe(200);
    expect(body).toEqual({ phrases: 2 });

    const [audio, fileName, contentType] = transcribe.mock.calls[0]!;
    expect(Buffer.compare(audio as Buffer, AUDIO)).toBe(0);
    expect(fileName).toBe("clip.webm");
    expect(contentType).toBe("audio/webm");

    // The call's clip counter, bound to its conversation.
    expect(ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
      TableName: DETAILS,
      Key: { callId: CALL, sk: "clips" },
      UpdateExpression: "ADD #n :one SET channelId = :c",
      ExpressionAttributeValues: { ":one": 1, ":max": MAX_NOTES_CLIPS, ":c": DM },
    });
    const row = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(row).toEqual({
      TableName: DETAILS,
      Item: {
        callId: CALL,
        sk: `clip#${String(STARTED).padStart(13, "0")}#${BOB.userId}`,
        channelId: DM,
        speaker: BOB.userId,
        startedAt: STARTED,
        durationMs: 240_000,
        lines: [
          { at: STARTED + 1500, text: "Hagamos el deploy del backend hoy." },
          { at: STARTED + 60_000, text: "Revisa los endpoints del dashboard." },
        ],
        by: ALICE.userId,
        createdAt: NOW,
        expiresAt: NOW / 1000 + 7 * 24 * 60 * 60,
      },
    });
    // The audio itself is stored nowhere.
    expect(JSON.stringify(row)).not.toContain(AUDIO.toString("base64"));
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it("stores nothing for a clip with no speech in it", async () => {
    transcribe.mockResolvedValueOnce({
      text: "",
      duration: 240,
      segments: [segment(0, WHISPER_PROMPT.slice(0, 60))],
    });
    expect((await send()).body).toEqual({ phrases: 0 });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("refuses outsiders, strangers' voices, other conversations and bad queries", async () => {
    expect((await send({}, { user: CAROL })).status).toBe(404);
    expect((await send({ channelId: GENERAL_CHANNEL_ID })).status).toBe(404);
    const stranger = await send({ speaker: CAROL.userId });
    expect(stranger.status).toBe(400);
    expect(stranger.body.message).toContain("speaker");
    expect((await send({ durationMs: String(10 * 60_000) })).status).toBe(400);
    expect((await send({ startedAt: "soon" })).status).toBe(400);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("refuses what isn't audio, an empty clip and a clip too large", async () => {
    expect((await send({}, { contentType: "text/plain" })).status).toBe(415);
    expect((await send({}, { base64: false })).status).toBe(400);
    expect((await send({}, { body: Buffer.alloc(0) })).status).toBe(400);
    expect((await send({}, { body: Buffer.alloc(MAX_NOTES_CLIP_BYTES + 1) })).status).toBe(413);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("refuses clips once the notes were requested, or past the call's limit", async () => {
    ddbMock
      .on(GetCommand, { TableName: DETAILS, Key: { callId: CALL, sk: "raw" } })
      .resolves({ Item: { callId: CALL, sk: "raw" } });
    expect((await send()).status).toBe(409);
    ddbMock.on(GetCommand, { TableName: DETAILS }).resolves({});
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "limit", $metadata: {} }));
    expect((await send()).status).toBe(429);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("maps Whisper's failures to answers the app can retry", async () => {
    const headers = new Headers();
    transcribe.mockRejectedValueOnce(new OpenAI.RateLimitError(429, {}, "slow down", headers));
    expect((await send()).status).toBe(503);
    transcribe.mockRejectedValueOnce(new OpenAI.APIConnectionTimeoutError());
    expect((await send()).status).toBe(504);
    transcribe.mockRejectedValueOnce(new OpenAI.BadRequestError(400, {}, "bad audio", headers));
    expect((await send()).status).toBe(422);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("answers 503 when no OpenAI key is configured", async () => {
    useSpeechToText(null);
    resetOpenAiKey();
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY_PARAMETER;
    try {
      const { status, body } = await send();
      expect(status).toBe(503);
      expect(body.message).toBe("Transcription isn't set up yet");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      resetOpenAiKey();
    }
  });
});

describe("whisperOf", () => {
  it("asks for whisper-1 in Spanish with the team's Spanglish prompt", async () => {
    const create = vi.fn(async () => heard);
    const whisper = whisperOf({ audio: { transcriptions: { create } } } as unknown as OpenAI);
    expect(await whisper.transcribe(AUDIO, "clip.webm", "audio/webm")).toBe(heard);
    const [params] = create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(params).toMatchObject({
      model: "whisper-1",
      language: "es",
      prompt:
        "Reunión de desarrollo de software de MindfulTech. Hablamos en español pero usamos términos en inglés como backend, frontend, deploy, API, endpoints, dashboard, framework, AWS, features, bugs.",
      response_format: "verbose_json",
    });
    const file = params.file as File;
    expect(file.name).toBe("clip.webm");
    expect(file.type).toBe("audio/webm");
    expect(Buffer.from(await file.arrayBuffer()).equals(AUDIO)).toBe(true);
  });
});

describe("clipLines", () => {
  it("falls back to the whole text without segments", () => {
    expect(clipLines({ text: " Listo el frontend. ", duration: 3 }, 1000)).toEqual([
      { at: 1000, text: "Listo el frontend." },
    ]);
  });

  it("keeps a plain 'gracias' (people say it), drops subtitle credits", () => {
    const lines = clipLines(
      {
        text: "",
        duration: 10,
        segments: [
          segment(0, " Gracias."),
          segment(2, " Subtítulos por la comunidad de Amara.org"),
        ],
      },
      0,
    );
    expect(lines.map((l) => l.text)).toEqual(["Gracias."]);
  });
});

describe("openaiApiKey", () => {
  const saved = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    ssmMock.reset();
    resetOpenAiKey();
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY_PARAMETER = "/slack/test/openai-api-key";
  });
  afterEach(() => {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    delete process.env.OPENAI_API_KEY_PARAMETER;
    resetOpenAiKey();
  });

  it("prefers OPENAI_API_KEY from the environment", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    expect(await openaiApiKey()).toBe("sk-from-env");
    expect(ssmMock.calls()).toHaveLength(0);
  });

  it("otherwise decrypts the stage's parameter, once per container", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: "sk-from-ssm\n" } });
    expect(await openaiApiKey()).toBe("sk-from-ssm");
    expect(await openaiApiKey()).toBe("sk-from-ssm");
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect(ssmMock.commandCalls(GetParameterCommand)[0]!.args[0].input).toEqual({
      Name: "/slack/test/openai-api-key",
      WithDecryption: true,
    });
  });

  it("is null while the parameter doesn't exist", async () => {
    ssmMock
      .on(GetParameterCommand)
      .rejects(new ParameterNotFound({ message: "nope", $metadata: {} }));
    expect(await openaiApiKey()).toBeNull();
  });
});
