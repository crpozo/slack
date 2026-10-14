import { useEffect, useState } from "react";
import { useChat, useNameOf } from "../store";

const EMPTY: Record<string, number> = {};

/** "Ana is typing…" for everyone whose indicator hasn't expired (nothing is stored server-side). */
export function typingLine(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

export function TypingIndicator({ channelId }: Readonly<{ channelId: string }>) {
  const typing = useChat((s) => s.typing[channelId] ?? EMPTY);
  const setTyping = useChat((s) => s.setTyping);
  const nameOf = useNameOf();
  // Re-render when the soonest indicator expires (and drop it from the store).
  const [, tick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const soonest = Math.min(...Object.values(typing));
    if (!Number.isFinite(soonest)) return;
    const timer = setTimeout(
      () => {
        const at = Date.now();
        for (const [userId, until] of Object.entries(typing)) {
          if (until <= at) setTyping(channelId, userId, null);
        }
        tick((n) => n + 1);
      },
      Math.max(0, soonest - now),
    );
    return () => clearTimeout(timer);
  }, [typing, channelId, setTyping]);

  const now = Date.now();
  const names = Object.entries(typing)
    .filter(([, until]) => until > now)
    .map(([userId]) => nameOf(userId));
  const line = typingLine(names);
  return (
    <p
      className="h-5 shrink-0 truncate px-4 text-xs text-ink-secondary"
      aria-live="polite"
      aria-hidden={line === null}
    >
      {line}
    </p>
  );
}
