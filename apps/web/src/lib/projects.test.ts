import { describe, expect, it } from "vitest";
import { projectBoardOf, projectChoiceOf, projectChoiceValid, projectEdit } from "./projects";

const linked = { isProject: true, linkedBoardId: "b_1" };
const plain = { isProject: false };

describe("project channel choice", () => {
  it("starts from the channel's current link", () => {
    expect(projectChoiceOf(linked)).toEqual({ isProject: true, mode: "link", boardId: "b_1" });
    expect(projectChoiceOf(plain)).toEqual({ isProject: false, mode: "link", boardId: "" });
    expect(projectChoiceOf(undefined).isProject).toBe(false);
  });

  it("needs a board once marked as a project", () => {
    expect(projectChoiceValid({ isProject: false, mode: "link", boardId: "" })).toBe(true);
    expect(projectChoiceValid({ isProject: true, mode: "link", boardId: "" })).toBe(false);
    expect(projectChoiceValid({ isProject: true, mode: "create", boardId: "" })).toBe(true);
    expect(projectBoardOf({ isProject: true, mode: "link", boardId: "b_2" })).toEqual({
      mode: "link",
      boardId: "b_2",
    });
  });

  it("sends only what changed on edit", () => {
    expect(projectEdit(linked, { isProject: true, mode: "link", boardId: "b_1" })).toEqual({});
    expect(projectEdit(linked, { isProject: true, mode: "link", boardId: "b_2" })).toEqual({
      isProject: true,
      board: { mode: "link", boardId: "b_2" },
    });
    expect(projectEdit(linked, { isProject: true, mode: "create", boardId: "" })).toEqual({
      isProject: true,
      board: { mode: "create" },
    });
    expect(projectEdit(linked, { isProject: false, mode: "link", boardId: "b_1" })).toEqual({
      isProject: false,
    });
    expect(projectEdit(plain, { isProject: false, mode: "link", boardId: "" })).toEqual({});
    expect(projectEdit(plain, { isProject: true, mode: "link", boardId: "" })).toEqual({});
  });
});
