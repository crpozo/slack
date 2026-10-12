import { describe, expect, it } from "vitest";
import {
  AddBoardMembersSchema,
  canAccessBoard,
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
});
