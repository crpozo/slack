import { type ProjectStatus } from "@mindfultech/shared";

/** What each status is called, in the order the switcher offers them. */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "Active",
  standby: "Standby",
  completed: "Completed",
};

/** Green once done, the brand sky while active; standby is a quiet hollow ring, never amber. */
const DOT_COLORS: Record<ProjectStatus, string> = {
  active: "bg-sky",
  standby: "border border-ink-secondary",
  completed: "bg-success",
};

/** How a standby channel's row looks in the lists: faded, back to full on hover or focus. */
export const STANDBY_FADE =
  "opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100";

/**
 * The small colored dot after a channel's name (Phase 81). In the lists only
 * completed channels have one: active is the usual case, and a standby
 * channel fades its whole row instead (`STANDBY_FADE`), so it asks for less
 * attention, not more. `always` draws it for every status (the switcher's options).
 */
export function ProjectStatusDot({
  status,
  always = false,
  className = "",
}: Readonly<{ status: ProjectStatus; always?: boolean; className?: string }>) {
  if (status !== "completed" && !always) return null;
  const label = `Project status: ${PROJECT_STATUS_LABELS[status]}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-project-status={status}
      className={`h-2 w-2 shrink-0 rounded-full ${DOT_COLORS[status]} ${className}`}
    />
  );
}
