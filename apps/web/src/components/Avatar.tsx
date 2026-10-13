interface AvatarProps {
  /** Display name (or email); its first letter is shown. */
  name: string | undefined;
  mine?: boolean;
  size?: "xs" | "sm" | "md" | "xl";
}

const SIZES = {
  xs: "h-5 w-5 text-[10px]",
  sm: "h-6 w-6 text-xs",
  md: "h-9 w-9 text-sm",
  xl: "h-24 w-24 text-4xl",
};

/** Initial on a tinted square: primary for you, sky for others. */
export function Avatar({ name, mine = false, size = "md" }: Readonly<AvatarProps>) {
  const initial = (name?.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-lg font-semibold text-on-accent ${SIZES[size]} ${
        mine ? "bg-primary" : "bg-sky"
      }`}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

/**
 * Presence: a filled green dot when online, a hollow gray ring when offline.
 * `overlay` pins it to the bottom-right of a relatively positioned avatar.
 */
export function PresenceDot({
  online,
  overlay = false,
}: Readonly<{ online: boolean; overlay?: boolean }>) {
  const label = online ? "Online" : "Offline";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full border-2 ${
        online ? "border-success bg-success" : "border-ink-secondary/70 bg-surface-sidebar"
      } ${overlay ? "absolute -bottom-0.5 -right-0.5 ring-2 ring-surface-sidebar" : ""}`}
    />
  );
}
