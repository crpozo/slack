import {
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_NOTES_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  type Attachment,
  type Board,
} from "@mindfultech/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTasks } from "../store/tasks";
import { Modal, SecondaryButton } from "./Modal";
import { PasteStatus, TaskImages, useImagePaste } from "./TaskImages";
import {
  AttachmentsSection,
  Field,
  ProjectAndAssignee,
  useFileDrop,
  useFileUploads,
} from "./TaskForm";

/**
 * "Add task": the same form as Task details, filled in before the task exists.
 * Nothing is saved until Create (attachments are uploaded as they are added so
 * they are ready by then); Cancel or Esc discards the draft.
 */
export function NewTaskModal({ board, onClose }: Readonly<{ board: Board; onClose: () => void }>) {
  const createTask = useTasks((s) => s.createTask);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [project, setProject] = useState("");
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleInput.current?.focus();
  }, []);

  const { uploads, addFiles, full } = useFileUploads(board.boardId, attachments.length, (added) =>
    setAttachments((list) => [...list, ...added]),
  );
  const drop = useFileDrop((files) => void addFiles(files));
  // Pasted images (Phase 33): uploaded as task files, referenced from the text.
  const addFile = (file: Attachment) => setAttachments((list) => [...list, file]);
  const descriptionPaste = useImagePaste({
    boardId: board.boardId,
    attached: attachments.length + uploads.length,
    apply: setDescription,
    onUploaded: addFile,
  });
  const notesPaste = useImagePaste({
    boardId: board.boardId,
    attached: attachments.length + uploads.length + descriptionPaste.pending,
    apply: setNotes,
    onUploaded: addFile,
  });
  const uploading = uploads.length + descriptionPaste.pending + notesPaste.pending;
  const canCreate = title.trim().length > 0 && uploading === 0;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canCreate) return;
    void createTask(board.boardId, {
      title: title.trim(),
      description: description.trim(),
      assigneeId,
      project: project.trim(),
      notes: notes.trim(),
      attachments,
    });
    onClose();
  }

  return (
    <Modal
      title="New task"
      width="lg"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="submit"
            form="new-task"
            className="btn-primary"
            disabled={!canCreate}
            title={uploading > 0 ? "Waiting for uploads to finish" : "Create (Enter)"}
          >
            {uploading > 0 ? "Uploading…" : "Create"}
          </button>
        </>
      }
    >
      <form id="new-task" onSubmit={submit} className="space-y-5" {...drop.handlers}>
        <Field id="task-title" label="Title">
          <input
            id="task-title"
            ref={titleInput}
            className="input text-base font-semibold"
            placeholder="What needs to be done?"
            maxLength={MAX_TASK_TITLE_LENGTH}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        <Field id="task-description" label="Details">
          <textarea
            id="task-description"
            className="input min-h-[3.5rem] resize-y"
            placeholder="A line or two shown on the card (optional). Paste a screenshot to add it."
            maxLength={MAX_TASK_DESCRIPTION_LENGTH}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onPaste={descriptionPaste.onPaste}
          />
          <PasteStatus pending={descriptionPaste.pending} />
          <TaskImages text={description} attachments={attachments} />
        </Field>

        <ProjectAndAssignee
          board={board}
          project={{ value: project, onChange: (e) => setProject(e.target.value) }}
          assigneeId={assigneeId}
          onAssigneeChange={setAssigneeId}
        />

        <Field id="task-notes" label="Notes">
          <textarea
            id="task-notes"
            className="input min-h-[10rem] resize-y leading-relaxed"
            placeholder="Context, links, decisions… (paste screenshots too)"
            maxLength={MAX_TASK_NOTES_LENGTH}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onPaste={notesPaste.onPaste}
          />
          <PasteStatus pending={notesPaste.pending} />
          <TaskImages text={notes} attachments={attachments} />
        </Field>

        <AttachmentsSection
          attachments={attachments}
          uploads={uploads}
          full={full}
          dragging={drop.dragging}
          onAdd={(files) => void addFiles(files)}
          onRemove={(key) => setAttachments((list) => list.filter((a) => a.key !== key))}
        />
      </form>
    </Modal>
  );
}
