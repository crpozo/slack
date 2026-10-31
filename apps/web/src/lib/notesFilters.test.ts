import type { AiNotes, Message } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import {
  categoryCounts,
  fold,
  matchesNotesFilter,
  NO_FILTER,
  notePreview,
  noteTitle,
  topTopics,
  unfiledCount,
} from "./notesFilters";

const card = (sk: string, notes: Partial<AiNotes>): Message =>
  ({
    channelId: "dm",
    sk,
    messageId: sk,
    userId: "u",
    text: "",
    attachments: [],
    createdAt: 1,
    kind: "ai_notes",
    aiNotes: {
      callId: sk,
      status: "ready",
      summary: "",
      startedAt: 1,
      endedAt: 2,
      participants: [],
      ...notes,
    },
  }) as unknown as Message;

const CARDS = [
  card("a", {
    category: "client",
    topics: ["Facturación", "Paymerch"],
    summary: "Revisamos la factura de octubre.",
  }),
  card("b", { category: "client", topics: ["facturacion"], summary: "Nuevo plan de precios." }),
  card("c", {
    category: "technical",
    topics: ["AWS", "Migración"],
    summary: "Moveremos la base a Aurora.",
  }),
  card("d", { summary: "Una llamada vieja sin categoría." }),
  card("e", { status: "pending" }),
];

describe("AI Notes filters", () => {
  it("fold ignores case, accents and extra spaces", () => {
    expect(fold("  Facturación   Mensual ")).toBe("facturacion mensual");
  });

  it("filters by category, by 'unfiled', by topic and by words (summary, topics, person)", () => {
    const pick = (f: Partial<typeof NO_FILTER>, peer = "") =>
      CARDS.filter((m) => matchesNotesFilter(m, { ...NO_FILTER, ...f }, peer)).map((m) => m.sk);
    expect(pick({})).toEqual(["a", "b", "c", "d", "e"]);
    expect(pick({ category: "client" })).toEqual(["a", "b"]);
    expect(pick({ category: "unfiled" })).toEqual(["d", "e"]);
    expect(pick({ topic: "FACTURACIÓN" })).toEqual(["a", "b"]);
    expect(pick({ query: "aurora" })).toEqual(["c"]);
    expect(pick({ query: "paymerch octubre" })).toEqual(["a"]);
    expect(pick({ query: "rené" }, "René")).toEqual(["a", "b", "c", "d", "e"]);
    expect(pick({ category: "client", query: "precios" })).toEqual(["b"]);
  });

  it("counts categories in their fixed order, and the most used topics (merged by spelling)", () => {
    expect(categoryCounts(CARDS)).toEqual([
      { category: "client", count: 2 },
      { category: "technical", count: 1 },
    ]);
    expect(topTopics(CARDS)).toEqual([
      { topic: "Facturación", count: 2 },
      { topic: "AWS", count: 1 },
      { topic: "Migración", count: 1 },
      { topic: "Paymerch", count: 1 },
    ]);
    expect(topTopics(CARDS, 2)).toHaveLength(2);
  });

  it("counts ready cards still waiting for a category or a title", () => {
    expect(unfiledCount(CARDS)).toBe(4);
    expect(unfiledCount([card("t", { category: "team", title: "Uno a uno", topics: [] })])).toBe(0);
  });

  it("previews the opening paragraph as plain text, stopping at the action items", () => {
    expect(
      notePreview(
        "## Resumen\n\nCarlos y **René** revisaron [el repo](https://x.y).\nAcordaron simplificar.\n\n## Action Items\n- **Carlos:** crear el repo",
      ),
    ).toBe("Carlos y René revisaron el repo. Acordaron simplificar.");
    expect(notePreview("Una línea.\n- un punto")).toBe("Una línea.");
    expect(notePreview("")).toBe("");
  });

  it("titles a card with the AI's title, else its first topic, else the person", () => {
    expect(noteTitle(card("x", { title: "Rediseño del render" }), "René")).toBe(
      "Rediseño del render",
    );
    expect(noteTitle(card("x", { topics: ["AWS"] }), "René")).toBe("AWS");
    expect(noteTitle(card("x", {}), "René")).toBe("Call with René");
  });
});
