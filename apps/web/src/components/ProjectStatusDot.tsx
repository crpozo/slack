import { type ProjectStatus } from "@mindfultech/shared";

/** What each status is called, in the order the switcher offers them. */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "Active",
  standby: "Standby",
  completed: "Completed",
};

/** Amber while it waits, green once done; active (the usual case) uses the brand sky. */
const DOT_COLORS: Record<ProjectStatus, string> = {
  active: "bg-sky",
  standby: "bg-warning",
  completed: "bg-success",
};

/**
 * The small colored dot after a channel's name (Phase 81). Active channels
 * show none in the lists, so only the ones that differ stand out; `always`
 * draws it for every status (the switcher's options).
 */
export function ProjectStatusDot({
  status,
  always = false,
  className = "",
}: Readonly<{ status: ProjectStatus; always?: boolean; className?: string }>) {
  if (status === "active" && !always) return null;
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
