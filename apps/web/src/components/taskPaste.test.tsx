// @vitest-environment jsdom
import type { Attachment, Board, Task } from "@mindfultech/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/upload", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/upload")>();
  return {
    ...real,
    uploadFile: vi.fn(),
    getDownloadUrl: vi.fn(async (key: string) => `https://files.example/${key}`),
  };
});

import { uploadFile } from "../lib/upload";
import { useChat } from "../store";
import { useTasks } from "../store/tasks";
import { NewTaskModal } from "./NewTaskModal";
import { TaskDetails } from "./TaskDetails";

// Regression: pasting a screenshot into a task's Notes put
// `![pasted-….png](attachment:…)` into the textarea. Now the paste is stopped,
// the file uploads in the background and joins the attachments, shown as a
// thumbnail; the notes stay plain text.

const upload = vi.mocked(uploadFile);
const ME = { userId: "u-me", email: "me@example.com", role: "member" as const };
const BOARD: Board = {
  boardId: "b_1",
  name: "Web",
  ownerId: ME.userId,
  members: [ME.userId],
  createdAt: 1,
};
const shot = (name = "image.png") => new File(["png"], name, { type: "image/png" });
const uploaded = (name: string): Attachment => ({
  key: `attachments/b_1/01ABC-${name}`,
  name,
  size: 3,
  contentType: "image/png",
});

/** A paste event carrying `files` (and optional text), as the browser sends it. */
function paste(target: HTMLElement, files: File[], text = "") {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(event, {
    clipboardData: {
      files,
      types: [...(files.length ? ["Files"] : []), ...(text ? ["text/plain"] : [])],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  useChat.setState({ me: ME, toast: null });
  upload.mockImplementation(async (file: File) => uploaded(file.name));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("pasting a screenshot into a new task's notes", () => {
  it("adds it to the attachments as a thumbnail, and never writes markdown into the notes", async () => {
    render(<NewTaskModal board={BOARD} onClose={() => {}} />);
    const notes = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    fireEvent.change(notes, { target: { value: "Steps to reproduce" } });

    const event = paste(notes, [shot()]);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/Uploading pasted file/);
    await waitFor(() => expect(screen.getByText("Attachments (1)")).toBeTruthy());

    expect(notes.value).toBe("Steps to reproduce");
    expect(notes.value).not.toMatch(/!\[|attachment:/);
    const [file] = upload.mock.calls[0]!;
    expect(file.name).toMatch(/^pasted-\d{8}-\d{6}\.png$/);
    await waitFor(() =>
      expect(document.querySelector("[data-attachment-thumb] img")?.getAttribute("src")).toMatch(
        /^https:\/\/files\.example\/attachments\/b_1\/01ABC-pasted-/,
      ),
    );
  });

  it("lets text paste as usual, spreadsheet cells included", () => {
    render(<NewTaskModal board={BOARD} onClose={() => {}} />);
    const notes = screen.getByLabelText("Notes");
    expect(paste(notes, [], "plain words").defaultPrevented).toBe(false);
    expect(paste(notes, [shot()], "A1\tB1").defaultPrevented).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it("attaches other pasted files too, as file rows", async () => {
    render(<NewTaskModal board={BOARD} onClose={() => {}} />);
    upload.mockImplementation(async (file: File) => ({
      key: `attachments/b_1/01ABC-${file.name}`,
      name: file.name,
      size: 3,
      contentType: "application/pdf",
    }));
    const notes = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    paste(notes, [new File(["%PDF"], "spec.pdf", { type: "application/pdf" })]);
    await waitFor(() => expect(screen.getByText("spec.pdf")).toBeTruthy());
    expect(notes.value).toBe("");
    expect(document.querySelector("[data-attachment-thumb]")).toBeNull();
  });
});

describe("pasting into an existing task's notes", () => {
  it("saves the file to the task's attachments and leaves the notes untouched", async () => {
    const task: Task = {
      taskId: "t_1",
      boardId: BOARD.boardId,
      title: "Fix the header",
      description: "",
      status: "TODO",
      assigneeId: null,
      project: "",
      notes: "Seen on Safari",
      attachments: [],
      createdBy: ME.userId,
      createdAt: 1,
      updatedAt: 1,
      doneAt: null,
      isArchived: false,
    };
    const editTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
      useTasks.setState((s) => ({
        tasksByBoard: {
          ...s.tasksByBoard,
          [BOARD.boardId]: [{ ...task, ...patch }],
        },
      }));
    });
    useTasks.setState({ tasksByBoard: { [BOARD.boardId]: [task] }, editTask } as never);
    render(<TaskDetails taskId="t_1" board={BOARD} onClose={() => {}} />);
    const notes = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    notes.focus();
    expect(paste(notes, [shot("mockup.png")]).defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith("t_1", { attachments: [uploaded("mockup.png")] }),
    );
    expect(notes.value).toBe("Seen on Safari");
    // Leaving the field saves nothing new: the notes never changed.
    fireEvent.blur(notes);
    expect(editTask).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("Attachments (1)")).toBeTruthy());
  });
});
