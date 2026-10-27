import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import Anthropic from "@anthropic-ai/sdk";
import { dmChannelId } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, useNotesModel, type NotesModel } from "../src/handlers/call-notes-worker";
import { NOTES_INSTRUCTION, NOTES_MODEL, NOTES_SYSTEM, type NotesJob } from "../src/lib/callNotes";
import { ALICE, BOB, ddbMock, resetMocks, sentEvents } from "./helpers";

const DM = dmChannelId(ALICE.userId, BOB.userId);
const T0 = 1_760_000_000_000;

const job = (): NotesJob => ({
  card: { channelId: DM, sk: "5#m5", messageId: "m5", members: [ALICE.userId, BOB.userId] },
  notes: {
    callId: "c1",
    status: "pending",
    summary: "",
    startedAt: T0,
    endedAt: T0 + 600_000,
    participants: [ALICE.userId, BOB.userId],
  },
  segments: [
    { userId: BOB.userId, text: "Sí, mañana a primera hora.", at: T0 + 20_000 },
    { userId: ALICE.userId, text: "¿Puedes revisar el contrato?", at: T0 + 12_000 },
  ],
});

const response = (patch: Partial<Anthropic.Message>): Anthropic.Message =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: NOTES_MODEL,
    content: [
      { type: "thinking", thinking: "", signature: "x" },
      {
        type: "text",
        text: "## Resumen\n\nAcordaron revisar el contrato.\n\n- **Ana**: revisar el contrato mañana",
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 40 },
    ...patch,
  }) as unknown as Anthropic.Message;

describe("call notes worker", () => {
  let create: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetMocks();
    create = vi.fn(async () => response({}));
    useNotesModel({ create } as unknown as NotesModel);
    ddbMock
      .on(GetCommand, { TableName: "slack-test-users", Key: { userId: ALICE.userId } })
      .resolves({
        Item: { displayName: "Alice", email: ALICE.email },
      });
    ddbMock
      .on(GetCommand, { TableName: "slack-test-users", Key: { userId: BOB.userId } })
      .resolves({
        Item: { email: "ana.maria@example.com" },
      });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
        { connectionId: "conn-carol", userId: "user-carol" },
      ],
    });
  });
  afterEach(() => useNotesModel(null));

  it("asks Haiku 5.5 with the product's instruction and one named, time-ordered transcript", async () => {
    await handler(job());
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params).toMatchObject({
      model: "us.anthropic.claude-haiku-5-5",
      max_tokens: 4096,
      output_config: { effort: "low" },
      system: NOTES_SYSTEM,
    });
    // No sampling parameters: Haiku 5.5 rejects them.
    expect(params).not.toHaveProperty("temperature");
    const content = params.messages[0]!.content as string;
    expect(content).toBe(
      `${NOTES_INSTRUCTION}\n\n<transcript>\n[00:12] Alice: ¿Puedes revisar el contrato?\n[00:20] ana.maria: Sí, mañana a primera hora.\n</transcript>`,
    );
  });

  it("fills the pending card with the markdown and tells only the two people", async () => {
    await handler(job());
    const update = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update).toMatchObject({
      TableName: "slack-test-messages",
      Key: { channelId: DM, sk: "5#m5" },
      ConditionExpression: "kind = :kind AND aiNotes.#status = :pending",
    });
    expect(update.ExpressionAttributeValues?.[":notes"]).toMatchObject({
      status: "ready",
      summary:
        "## Resumen\n\nAcordaron revisar el contrato.\n\n- **Ana**: revisar el contrato mañana",
    });
    expect(update.ExpressionAttributeValues?.[":text"]).toBe("✨ AI call notes: Resumen");
    expect(sentEvents().map(([id, e]) => `${id}:${e.type}`)).toEqual([
      "conn-alice:message.updated",
      "conn-bob:message.updated",
    ]);
    expect(sentEvents()[0]?.[1]).toMatchObject({
      channelId: DM,
      sk: "5#m5",
      messageId: "m5",
      aiNotes: { status: "ready" },
    });
  });

  it("a refusal or a cut-off answer becomes a failed card, never half-notes", async () => {
    create.mockResolvedValueOnce(response({ stop_reason: "refusal" }));
    await handler(job());
    create.mockResolvedValueOnce(response({ stop_reason: "max_tokens" }));
    await handler(job());
    const [refused, cut] = ddbMock
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input.ExpressionAttributeValues?.[":notes"]);
    expect(refused).toMatchObject({ status: "failed", summary: "" });
    expect(cut).toMatchObject({ status: "failed", error: expect.stringContaining("cut off") });
  });

  it("an API error becomes a failed card instead of an async retry", async () => {
    create.mockRejectedValueOnce(new Anthropic.APIConnectionError({ message: "socket hang up" }));
    await expect(handler(job())).resolves.toBeUndefined();
    const notes =
      ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input.ExpressionAttributeValues?.[":notes"];
    expect(notes).toMatchObject({
      status: "failed",
      error: "The notes service couldn't be reached.",
    });
  });

  it("leaves a card that was already settled alone and says nothing", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "settled", $metadata: {} }));
    await handler(job());
    expect(sentEvents()).toEqual([]);
  });
});
