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
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-lg font-semibold ${SIZES[size]} ${
        mine ? "bg-primary text-on-primary" : "bg-sky text-on-accent"
      }`}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

/** 10×10 SVG dots: filled success green, or a hollow gray ring (mid-gray reads in both themes). */
const dotSrc = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const PRESENCE_DOTS = {
  online: dotSrc(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#2BAC76"/></svg>',
  ),
  offline: dotSrc(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="none" stroke="#8A8D96" stroke-width="2"/></svg>',
  ),
};

/**
 * Presence: a filled green dot when online, a hollow gray ring when offline.
 * `overlay` pins it to the bottom-right of a relatively positioned avatar, on a
 * sidebar-coloured backing so the hollow ring doesn't show the avatar through it.
 */
export function PresenceDot({
  online,
  overlay = false,
}: Readonly<{ online: boolean; overlay?: boolean }>) {
  const label = online ? "Online" : "Offline";
  const img = (
    <img
      src={online ? PRESENCE_DOTS.online : PRESENCE_DOTS.offline}
      alt={label}
      title={label}
      width={10}
      height={10}
      className="block h-2.5 w-2.5"
    />
  );
  if (!overlay) return img;
  return (
    <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-surface-sidebar ring-2 ring-surface-sidebar">
      {img}
    </span>
  );
}

/**
 * Phones (Phase 37), Slack-style: a green dot when online, a gray "z" when
 * not, on a disc of the background colour, pinned to the bottom-right corner of
 * a relatively positioned avatar.
 */
export function StatusBadge({
  online,
  ringClass = "bg-surface ring-surface",
}: Readonly<{ online: boolean; ringClass?: string }>) {
  const label = online ? "Online" : "Away";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-status={online ? "online" : "away"}
      className={`absolute -bottom-1 -right-1 flex h-[15px] w-[15px] items-center justify-center rounded-full ring-2 ${ringClass}`}
    >
      {online ? (
        <span className="h-[11px] w-[11px] rounded-full bg-success" />
      ) : (
        <span className="text-[11px] font-black italic leading-none text-ink-secondary">z</span>
      )}
    </span>
  );
}
