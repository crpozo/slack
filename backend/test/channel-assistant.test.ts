import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Channel } from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler, useChannelAssistantModel } from "../src/handlers/messages";
import type { HttpEvent } from "../src/lib/http";
import { ALICE, BOB, ddbMock, GENERAL, mockChannels, resetMocks } from "./helpers";

// Phase 68: every conversation's AI companion.

const MESSAGES = "slack-test-messages";
const PRIVATE: Channel = {
  channelId: "ch_private",
  name: "WFS Website",
  type: "private",
  createdBy: ALICE.userId,
  createdAt: 1,
  archived: false,
  members: [ALICE.userId],
};

function ask(
  channelId: string,
  body: unknown,
  user: { userId: string; email: string; groups?: string[] } = ALICE,
): Promise<{ statusCode: number; body: string }> {
  return handler({
    routeKey: "POST /channels/{channelId}/ask",
    pathParameters: { channelId },
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            sub: user.userId,
            email: user.email,
            ...(user.groups && { "cognito:groups": user.groups }),
          },
        },
      },
    },
  } as unknown as HttpEvent) as Promise<{ statusCode: number; body: string }>;
}

const create = vi.fn();
beforeEach(() => {
  resetMocks();
  process.env.USERS_TABLE = "slack-test-users";
  mockChannels(GENERAL, PRIVATE);
  ddbMock.on(GetCommand, { TableName: "slack-test-users" }).resolves({});
  ddbMock
    .on(GetCommand, { TableName: "slack-test-users", Key: { userId: ALICE.userId } })
    .resolves({ Item: { displayName: "Alice", email: ALICE.email } });
  // Newest first, as the table is read.
  ddbMock.on(QueryCommand, { TableName: MESSAGES }).resolves({
    Items: [
      { userId: ALICE.userId, createdAt: 3, text: "Listo, ya publiqué los cambios." },
      { userId: ALICE.userId, createdAt: 2, text: "secreto", isSecret: true },
      { userId: BOB.userId, createdAt: 2, text: "borrado", deletedAt: 9 },
      {
        userId: ALICE.userId,
        createdAt: 1,
        text: "Falta validar Odoo.",
        parentSk: "0#x",
        attachments: [{ name: "informe.pdf" }],
      },
    ],
  });
  create.mockReset();
  create.mockResolvedValue({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "- Validar Odoo (Alice)" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  useChannelAssistantModel({ create, stream: vi.fn() } as never);
});

describe("the conversation's AI companion", () => {
  it("answers from the conversation's messages, oldest first, never secrets or deleted ones", async () => {
    const res = await ask(PRIVATE.channelId, { question: "¿Qué queda pendiente?" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      answer: "- Validar Odoo (Alice)",
      read: 2,
      since: 1,
    });
    const params = create.mock.calls[0]![0];
    const conversation = params.system[1].text as string;
    expect(conversation).toContain("#WFS Website");
    expect(conversation.indexOf("Falta validar Odoo.")).toBeLessThan(
      conversation.indexOf("Listo, ya publiqué"),
    );
    expect(conversation).toContain(
      "Alice (en un hilo): Falta validar Odoo. [adjuntos: informe.pdf]",
    );
    expect(conversation).not.toMatch(/secreto|borrado/);
    expect(params.messages.at(-1)).toEqual({ role: "user", content: "¿Qué queda pendiente?" });
  });

  it("is only for someone who sees the conversation, and not for guests", async () => {
    expect((await ask(PRIVATE.channelId, { question: "hola" }, BOB)).statusCode).toBe(404);
    expect(
      (await ask(GENERAL.channelId, { question: "hola" }, { ...BOB, groups: ["guests"] }))
        .statusCode,
    ).toBe(403);
    expect((await ask(PRIVATE.channelId, { question: "" })).statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("says so when the model fails", async () => {
    create.mockRejectedValue(new Error("down"));
    expect((await ask(PRIVATE.channelId, { question: "hola" })).statusCode).toBe(502);
  });
});
