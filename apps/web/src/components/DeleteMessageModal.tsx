import { replyPreview } from "@mindfultech/shared";
import { chat } from "../lib/chat";
import { useChat, useNameOf, type ChatMessage } from "../store";
import { Modal, SecondaryButton } from "./Modal";
import { TrashIcon } from "./icons";

/**
 * "Delete message?" (Phase 32): what's about to go, whose it is when an admin
 * deletes someone else's, and what happens to a thread under it. Deleting
 * can't be undone; files go with the message.
 */
export function DeleteMessageModal({
  message,
  onClose,
}: Readonly<{ message: ChatMessage; onClose: () => void }>) {
  const myUserId = useChat((s) => s.me?.userId);
  const nameOf = useNameOf();
  const someoneElses = message.userId !== myUserId;
  const replies = message.parentSk ? 0 : (message.replyCount ?? 0);
  const files = message.attachments.length;
  const preview = message.isSecret
    ? "🔒 Secret"
    : replyPreview(message.text) || (message.kind === "ai_notes" ? "✨ AI call notes" : "");

  return (
    <Modal
      title="Delete message?"
      width="sm"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg bg-error px-4 py-2 text-sm font-semibold text-white hover:bg-error/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            onClick={() => {
              onClose();
              void chat.deleteMessage(message);
            }}
          >
            <TrashIcon aria-hidden="true" />
            Delete
          </button>
        </>
      }
    >
      {someoneElses && (
        <p className="mb-2 rounded-lg bg-warning/15 px-3 py-2 text-xs text-ink">
          You&apos;re deleting <strong>{nameOf(message.userId)}</strong>&apos;s message as an admin.
        </p>
      )}
      {(preview || files > 0) && (
        <blockquote className="line-clamp-4 break-words rounded-lg border-l-2 border-error/60 bg-surface-sidebar px-3 py-2 text-sm text-ink">
          {preview}
          {files > 0 && (
            <span className="block text-xs text-ink-secondary">
              📎 {files === 1 ? "1 file" : `${files} files`}, deleted with it
            </span>
          )}
        </blockquote>
      )}
      <p className="mt-3 text-sm text-ink-secondary">
        {replies > 0
          ? `Its ${replies === 1 ? "reply stays" : `${replies} replies stay`}; the message shows as deleted. `
          : "It disappears for everyone. "}
        This can&apos;t be undone.
      </p>
    </Modal>
  );
}
