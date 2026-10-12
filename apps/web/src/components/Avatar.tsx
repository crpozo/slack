interface AvatarProps {
  /** Display name (or email); its first letter is shown. */
  name: string | undefined;
  mine?: boolean;
  size?: "xs" | "sm" | "md";
}

const SIZES = { xs: "h-5 w-5 text-[10px]", sm: "h-6 w-6 text-xs", md: "h-9 w-9 text-sm" };

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
