// @ts-check

/** Token backed by a CSS variable holding "R G B", so Tailwind's opacity modifiers keep working. */
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

/**
 * MindfulTech design system. Values live in src/styles.css as CSS variables:
 * one dark theme everywhere (Phase 37b), Slack's palette with purple accents.
 *
 * `primary` is split: fills (`bg-primary`, #611F69) use `--c-primary`, with
 * `on-primary` (white) text on them; text, borders, rings, underlines and
 * icon strokes use `--c-primary-fg` (lilac #E3B0F0), which is readable on the
 * dark background where the fill purple isn't. Text on sky, green, amber and
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
        /** Text on a solid primary fill (white on the purple). */
        "on-primary": token("on-primary"),
        /** Modal and drawer backdrops. */
        scrim: token("scrim"),
      },
      // Primary as a foreground (see above): the readable lilac.
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
