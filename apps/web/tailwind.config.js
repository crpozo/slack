// @ts-check

/** Token backed by a CSS variable holding "R G B", so Tailwind's opacity modifiers keep working. */
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

/**
 * MindfulTech design system. Values live in src/styles.css as CSS variables:
 * one dark theme everywhere (Phase 37b), with the brand green #40B375 as accent.
 *
 * `primary` is split: fills (`bg-primary`) use `--c-primary`, with
 * `on-primary` (black) text on them; text, borders, rings, underlines and
 * icon strokes use `--c-primary-fg`. Both are #40B375 today; they stay
 * separate tokens so a fill and a foreground can differ again if the
 * palette needs it (Phase 37's purple did). Text on sky, green, amber and
 * red uses `on-accent` (the dark ink).
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: token("primary"),
          hover: token("primary-hover"),
        },
        sky: {
          DEFAULT: token("sky"),
        },
        info: token("sky"),
        ink: {
          DEFAULT: token("ink"),
          secondary: token("ink-secondary"),
        },
        surface: {
          DEFAULT: token("surface"),
          sidebar: token("surface-sidebar"),
          hover: token("surface-hover"),
          raised: token("surface-raised"),
        },
        line: token("line"),
        success: token("success"),
        warning: token("warning"),
        error: token("error"),
        /** Text on sky, green, amber and red: the dark ink #0E0D12. */
        "on-accent": token("on-accent"),
        /** Text on a solid primary fill (black on the green, 7.9:1). */
        "on-primary": token("on-primary"),
        /** Modal and drawer backdrops. */
        scrim: token("scrim"),
      },
      // Primary as a foreground (see above).
      textColor: { primary: { DEFAULT: token("primary-fg"), hover: token("primary-fg") } },
      borderColor: { primary: { DEFAULT: token("primary-fg"), hover: token("primary-fg") } },
      ringColor: { primary: { DEFAULT: token("primary-fg"), hover: token("primary-fg") } },
      outlineColor: { primary: token("primary-fg") },
      textDecorationColor: {
        primary: { DEFAULT: token("primary-fg"), hover: token("primary-fg") },
      },
      caretColor: { primary: token("primary-fg") },
      accentColor: { primary: token("primary-fg") },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      maxHeight: {
        /** Image previews in the chat: a compact, Slack-like box, whatever the monitor. */
        attachment: "300px",
      },
    },
  },
  plugins: [],
};
