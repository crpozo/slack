import { Moon, Sun } from "lucide-react";
import { setAppearance, useAppearance } from "../lib/theme";

/** What the theme switch says and shows: the look it would change to. */
export function useThemeSwitch() {
  const appearance = useAppearance();
  const light = appearance === "light";
  return {
    light,
    label: light ? "Dark theme" : "Light theme",
    icon: light ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />,
    toggle: () => setAppearance(light ? "dark" : "light"),
  };
}

/** The light/dark switch as an icon button (Phase 76); the choice stays in this browser. */
export function ThemeToggle({ className }: Readonly<{ className: string }>) {
  const { label, icon, toggle } = useThemeSwitch();
  return (
    <button
      type="button"
      onClick={toggle}
      className={className}
      aria-label={label}
      title={label}
      data-theme-toggle
    >
      {icon}
    </button>
  );
}
