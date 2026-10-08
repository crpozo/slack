interface AvatarProps {
  email: string | undefined;
  mine?: boolean;
  size?: "sm" | "md";
}

/** Initial of the email on a tinted square: primary for you, sky for others. */
export function Avatar({ email, mine = false, size = "md" }: AvatarProps) {
  const initial = (email?.[0] ?? "?").toUpperCase();
  const dims = size === "sm" ? "h-6 w-6 text-xs" : "h-9 w-9 text-sm";
  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-lg font-semibold text-ink ${dims} ${
        mine ? "bg-primary" : "bg-sky"
      }`}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
