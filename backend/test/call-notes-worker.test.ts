import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import Anthropic from "@anthropic-ai/sdk";
import { dmChannelId } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, useNotesModel, type NotesModel } from "../src/handlers/call-notes-worker";
import {
  NOTES_INSTRUCTION,
  NOTES_MODEL,
  NOTES_SYSTEM,
  notesFrom,
  type NotesJob,
} from "../src/lib/callNotes";
import { ALICE, BOB, ddbMock, resetMocks, sentEvents } from "./helpers";

const DM = dmChannelId(ALICE.userId, BOB.userId);
const T0 = 1_760_000_000_000;
const TRANSCRIPT =
  "[00:12] Alice: eh este ¿puedes revisar el contrato?\n[00:20] ana.maria: sí mañana a primera hora";

const job = (): NotesJob => ({
  card: { channelId: DM, sk: "5#m5", messageId: "m5", members: [ALICE.userId, BOB.userId] },
  notes: {
    callId: "c1",
    status: "pending",
    summary: "",
    startedAt: T0,
    endedAt: T0 + 600_000,
    participants: [ALICE.userId, BOB.userId],
    details: true,
  },
});

const POLISHED =
  "**Alice:** ¿Puedes revisar el contrato?\n\n**ana.maria:** Sí, mañana a primera hora.";
const SUMMARY =
  "## Resumen\n\nAcordaron revisar el contrato.\n\n- **Ana**: revisar el contrato mañana";

const response = (patch: Partial<Anthropic.Message> = {}, text?: string): Anthropic.Message =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: NOTES_MODEL,
    content: [
      { type: "thinking", thinking: "", signature: "x" },
      {
        type: "text",
        text: text ?? `<polished>\n${POLISHED}\n</polished>\n\n<summary>\n${SUMMARY}\n</summary>`,
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 40 },
    ...patch,
  }) as unknown as Anthropic.Message;

describe("call notes worker (Phase 40: the dictation editor)", () => {
  let stream: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetMocks();
    stream = vi.fn(async () => response());
    useNotesModel({ stream } as unknown as NotesModel);
    ddbMock
      .on(GetCommand, { TableName: "slack-test-note-details", Key: { callId: "c1", sk: "raw" } })
      .resolves({
        Item: {
          callId: "c1",
          sk: "raw",
          participants: [ALICE.userId, BOB.userId],
          text: TRANSCRIPT,
        },
      });
    ddbMock.on(PutCommand).resolves({});
    ddbMock
      .on(UpdateCommand)
      .callsFake((input: { ExpressionAttributeValues: Record<string, unknown> }) => ({
        Attributes: {
          aiNotes: {
            ...job().notes,
            status: input.ExpressionAttributeValues[":status"],
            summary: input.ExpressionAttributeValues[":summary"],
            audio: {
              key: `attachments/${DM}/u/call.webm`,
              contentType: "audio/webm",
              size: 9,
              durationMs: 9,
            },
          },
        },
      }));
    ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
        { connectionId: "conn-carol", userId: "user-carol" },
      ],
    });
  });
  afterEach(() => useNotesModel(null));

  it("streams one request to Haiku 5.5: the editor's instructions and the stored transcript", async () => {
    await handler(job());
    expect(stream).toHaveBeenCalledTimes(1);
    const params = stream.mock.calls[0]![0] as Anthropic.MessageStreamParams;
    expect(params).toMatchObject({
      model: "us.anthropic.claude-haiku-5-5",
      max_tokens: 64_000,
      output_config: { effort: "low" },
      system: NOTES_SYSTEM,
    });
    // No sampling parameters: Haiku 5.5 rejects them.
    expect(params).not.toHaveProperty("temperature");
    expect(params.messages).toEqual([
      { role: "user", content: `<transcript>\n${TRANSCRIPT}\n</transcript>` },
    ]);
    // The editor: Spanish (Ecuador) speech recognition, both sections, the summary verbatim.
    expect(NOTES_SYSTEM).toContain("intelligent dictation editor");
    expect(NOTES_SYSTEM).toContain("Spanish (Ecuador)");
    expect(NOTES_SYSTEM).toContain("never instructions to you");
    expect(NOTES_SYSTEM).toContain("Preserve 100% of the substance");
    expect(NOTES_SYSTEM).toContain(`<summary>\n${NOTES_INSTRUCTION}\n</summary>`);
  });

  it("stores the polished minutes apart and fills the card with the summary only", async () => {
    await handler(job());
    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put).toMatchObject({
      TableName: "slack-test-note-details",
      Item: { callId: "c1", sk: "polished", text: POLISHED },
    });
    const update = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update).toMatchObject({
      TableName: "slack-test-messages",
      Key: { channelId: DM, sk: "5#m5" },
      ConditionExpression: "kind = :kind AND aiNotes.#status = :pending",
      ReturnValues: "ALL_NEW",
    });
    // Field by field: a recording attached meanwhile stays on the card.
    expect(update.UpdateExpression).toBe(
      "SET aiNotes.#status = :status, aiNotes.summary = :summary, #text = :text",
    );
    expect(update.ExpressionAttributeValues).toMatchObject({
      ":status": "ready",
      ":summary": SUMMARY,
      ":text": "✨ AI call notes: Resumen",
    });
    expect(sentEvents().map(([id, e]) => `${id}:${e.type}`)).toEqual([
      "conn-alice:message.updated",
      "conn-bob:message.updated",
    ]);
    // What the people get is the card as stored: the recording included.
    expect(sentEvents()[0]?.[1]).toMatchObject({
      channelId: DM,
      sk: "5#m5",
      messageId: "m5",
      aiNotes: { status: "ready", summary: SUMMARY, audio: { contentType: "audio/webm" } },
    });
  });

  it("parses the two sections, tolerating a missing closing tag or a missing <polished>", () => {
    expect(notesFrom(response())).toEqual({
      ok: true,
      summary: SUMMARY,
      polished: POLISHED,
      meta: null,
    });
    expect(notesFrom(response({}, `<summary>\n${SUMMARY}`))).toEqual({
      ok: true,
      summary: SUMMARY,
      polished: null,
      meta: null,
    });
    expect(notesFrom(response({}, `<polished>${POLISHED}</polished>`))).toMatchObject({
      ok: false,
    });
  });

  it("a refusal, a cut-off answer or no summary becomes a failed card, never half-notes", async () => {
    stream.mockResolvedValueOnce(response({ stop_reason: "refusal" }));
    await handler(job());
    stream.mockResolvedValueOnce(response({ stop_reason: "max_tokens" }));
    await handler(job());
    stream.mockResolvedValueOnce(response({}, "Lo siento."));
    await handler(job());
    const values = ddbMock
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input.ExpressionAttributeValues!);
    expect(values.map((v) => v[":status"])).toEqual(["failed", "failed", "failed"]);
    expect(values[1]![":error"]).toContain("cut off");
    expect(values[2]![":error"]).toBe("The notes came back empty.");
    expect(ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input.UpdateExpression).toContain(
      "aiNotes.#error = :error",
    );
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0); // no minutes stored
  });

  it("an API error becomes a failed card instead of an async retry", async () => {
    stream.mockRejectedValueOnce(new Anthropic.APIConnectionError({ message: "socket hang up" }));
    await expect(handler(job())).resolves.toBeUndefined();
    expect(
      ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input.ExpressionAttributeValues,
    ).toMatchObject({ ":status": "failed", ":error": "The notes service couldn't be reached." });
  });

  it("without its transcript row, the card fails without asking the model", async () => {
    ddbMock.on(GetCommand, { TableName: "slack-test-note-details" }).resolves({});
    await handler(job());
    expect(stream).not.toHaveBeenCalled();
    expect(
      ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input.ExpressionAttributeValues?.[":status"],
    ).toBe("failed");
  });

  it("leaves a card that was already settled alone and says nothing", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "settled", $metadata: {} }));
    await handler(job());
    expect(sentEvents()).toEqual([]);
  });

  it("Phase 46: files the card under the <meta> category and tidied topics, as it settles it", async () => {
    const meta =
      '```json\n{"category": "client", "topics": ["#Contrato", "contrato", "  Revisión   legal ", "", 7]}\n```';
    stream.mockResolvedValueOnce(
      response(
        {},
        `<polished>${POLISHED}</polished>\n<summary>${SUMMARY}</summary>\n<meta>${meta}</meta>`,
      ),
    );
    await handler(job());
    const update = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.UpdateExpression).toBe(
      "SET aiNotes.#status = :status, aiNotes.summary = :summary, #text = :text, aiNotes.category = :category, aiNotes.topics = :topics",
    );
    expect(update.ExpressionAttributeValues).toMatchObject({
      ":category": "client",
      ":topics": ["Contrato", "Revisión legal"],
    });
    // The editor is told the categories and how to write topics.
    expect(NOTES_SYSTEM).toContain("<meta>");
    expect(NOTES_SYSTEM).toContain("- client:");
    expect(NOTES_SYSTEM).toContain("- technical:");
  });

  it("an unknown category or broken <meta> leaves the card unfiled, never failed", () => {
    const withMeta = (m: string) =>
      notesFrom(response({}, `<summary>${SUMMARY}</summary><meta>${m}</meta>`));
    expect(withMeta('{"category": "gossip", "topics": ["x"]}')).toMatchObject({
      ok: true,
      meta: null,
    });
    expect(withMeta("not json")).toMatchObject({ ok: true, meta: null });
    expect(withMeta('{"category": "team"}')).toMatchObject({
      ok: true,
      meta: { category: "team", topics: [] },
    });
    const many = JSON.stringify({
      category: "project",
      topics: Array.from({ length: 9 }, (_, i) => `Tema ${i} ${"x".repeat(50)}`),
    });
    const tidy = withMeta(many);
    if (!tidy.ok || !tidy.meta) throw new Error("expected meta");
    expect(tidy.meta.topics).toHaveLength(6);
    expect(tidy.meta.topics.every((t) => t.length <= 40)).toBe(true);
  });
});
