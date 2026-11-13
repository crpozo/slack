import { systemNoteText, type Message } from "@mindfultech/shared";
import { memo } from "react";
import { useNameOf } from "../store";
import { formatTime } from "../lib/channels";

/**
 * Phase 63: a line the server wrote when the channel's members changed
 * ("@Luis was removed from the channel by Ana"): small, centered and gray,
 * with no avatar, actions or reactions. Names are read now, so a renamed
 * person shows under their current name.
 */
export const SystemNote = memo(function SystemNote({ message }: Readonly<{ message: Message }>) {
  const nameOf = useNameOf();
  const text = message.system ? systemNoteText(message.system, (id) => nameOf(id)) : message.text;
  return (
    <div
      className="flex justify-center px-4 py-1.5"
      data-system-note={message.system?.event ?? "system"}
      role="note"
    >
      <p className="max-w-full truncate text-center text-xs text-ink-secondary">
        {text}
        <time
          className="ml-1.5 text-[11px] text-ink-secondary/70"
          dateTime={new Date(message.createdAt).toISOString()}
        >
          {formatTime(message.createdAt)}
        </time>
      </p>
    </div>
  );
});
