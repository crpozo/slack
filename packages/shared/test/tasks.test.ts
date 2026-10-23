import { describe, expect, it } from "vitest";
import {
  AddBoardMembersSchema,
  ARCHIVE_DONE_AFTER_MS,
  canAccessBoard,
  isTaskArchived,
  CreateBoardSchema,
  CreateTaskSchema,
  MAX_TASK_TITLE_LENGTH,
  UpdateTaskSchema,
} from "../src";

describe("tasks contract", () => {
  it("board access is the owner or a member, nobody else", () => {
    const board = { ownerId: "u1", members: ["u1", "u2"] };
    expect(canAccessBoard(board, "u1")).toBe(true);
    expect(canAccessBoard(board, "u2")).toBe(true);
    expect(canAccessBoard(board, "u3")).toBe(false);
    expect(canAccessBoard({ ownerId: "u1", members: [] }, "u1")).toBe(true);
  });

  it("trims and bounds board names", () => {
    expect(CreateBoardSchema.parse({ name: "  Launch  " })).toEqual({ name: "Launch" });
    expect(CreateBoardSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(CreateBoardSchema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
    expect(CreateBoardSchema.safeParse({ name: "bad\u0007" }).success).toBe(false);
  });

  it("validates member invitations as user ids", () => {
    expect(AddBoardMembersSchema.parse({ userIds: ["u2", "u3"] })).toEqual({
      userIds: ["u2", "u3"],
    });
    expect(AddBoardMembersSchema.safeParse({ userIds: [] }).success).toBe(false);
    expect(AddBoardMembersSchema.safeParse({ userIds: ["has_underscore"] }).success).toBe(false);
    expect(AddBoardMembersSchema.safeParse({ userIds: Array(21).fill("u") }).success).toBe(false);
  });

  it("tasks need a title; the description defaults to empty", () => {
    expect(CreateTaskSchema.parse({ title: " Ship it " })).toEqual({
      title: "Ship it",
      description: "",
      assigneeId: null,
      project: "",
      notes: "",
      attachments: [],
    });
    expect(CreateTaskSchema.safeParse({ title: "" }).success).toBe(false);
    expect(
      CreateTaskSchema.safeParse({ title: "x".repeat(MAX_TASK_TITLE_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it("updates are partial, typed and never empty", () => {
    expect(UpdateTaskSchema.parse({ status: "DONE" })).toEqual({ status: "DONE" });
    expect(UpdateTaskSchema.parse({ title: "New", description: "" })).toEqual({
      title: "New",
      description: "",
    });
    expect(UpdateTaskSchema.safeParse({}).success).toBe(false);
    expect(UpdateTaskSchema.safeParse({ status: "ARCHIVED" }).success).toBe(false);
    expect(UpdateTaskSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("validates the detail fields: assignee id, project length, attachments shape and count", () => {
    const attachment = {
      key: "attachments/b_1/x.pdf",
      name: "x.pdf",
      size: 10,
      contentType: "application/pdf",
    };
    expect(
      CreateTaskSchema.parse({
        title: "t",
        assigneeId: "u2",
        project: " Web ",
        notes: "n",
        attachments: [attachment],
      }),
    ).toMatchObject({ assigneeId: "u2", project: "Web", notes: "n", attachments: [attachment] });
    expect(CreateTaskSchema.safeParse({ title: "t", assigneeId: "bad_id" }).success).toBe(false);
    expect(CreateTaskSchema.safeParse({ title: "t", project: "x".repeat(41) }).success).toBe(false);
    expect(CreateTaskSchema.safeParse({ title: "t", attachments: [{ key: "k" }] }).success).toBe(
      false,
    );
    expect(
      CreateTaskSchema.safeParse({ title: "t", attachments: Array(11).fill(attachment) }).success,
    ).toBe(false);

    expect(UpdateTaskSchema.parse({ assigneeId: null })).toEqual({ assigneeId: null });
    expect(UpdateTaskSchema.parse({ attachments: [] })).toEqual({ attachments: [] });
    expect(UpdateTaskSchema.safeParse({ notes: "x".repeat(5001) }).success).toBe(false);
  });
});

describe("isTaskArchived", () => {
  const now = 10 * ARCHIVE_DONE_AFTER_MS;
  it("archives done tasks after a week, or when flagged", () => {
    const done = { status: "DONE" as const, isArchived: false };
    expect(isTaskArchived({ ...done, doneAt: now - ARCHIVE_DONE_AFTER_MS - 1 }, now)).toBe(true);
    expect(isTaskArchived({ ...done, doneAt: now - 1000 }, now)).toBe(false);
    expect(isTaskArchived({ ...done, doneAt: null, isArchived: true }, now)).toBe(true);
  });

  it("never archives a task that isn't done", () => {
    expect(isTaskArchived({ status: "TODO", doneAt: 0, isArchived: true }, now)).toBe(false);
  });
});

describe("line breaks in a task's long fields", () => {
  const create = (fields: Record<string, unknown>) =>
    CreateTaskSchema.safeParse({ title: "Ship it", ...fields });

  it("keeps line breaks in the description and notes, storing Windows ones as \\n", () => {
    const parsed = create({ description: "first\r\nsecond\nthird", notes: "a\n\tb" });
    expect(parsed.success && parsed.data.description).toBe("first\nsecond\nthird");
    expect(parsed.success && parsed.data.notes).toBe("a\n\tb");
    const update = UpdateTaskSchema.safeParse({ description: "one\ntwo" });
    expect(update.success && update.data.description).toBe("one\ntwo");
  });

  it("still refuses other control characters there, and any in one-line fields", () => {
    expect(create({ description: "bell\u0007" }).success).toBe(false);
    expect(create({ notes: "nul\u0000" }).success).toBe(false);
    expect(create({ title: "two\nlines" }).success).toBe(false);
    expect(create({ project: "a\nb" }).success).toBe(false);
  });
});
