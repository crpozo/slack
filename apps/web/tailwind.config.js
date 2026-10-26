// @ts-check

/** Token backed by a CSS variable holding "R G B", so Tailwind's opacity modifiers keep working. */
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

/**
 * MindfulTech design system. Values live in src/styles.css as CSS variables
 * with a light set on :root and a dark set on .dark, so every utility
 * (bg-surface, text-ink, bg-primary/15…) switches theme without `dark:` variants.
 * Contrast: primary (#69C7B9) and sky (#85BFE9) are light in both themes, so text on
 * them uses `on-accent` (always the dark ink), never white.
 *
 * Phones (Phase 37, `html.phone`) swap the teal for Slack's purple, which can't be
 * both a fill under white text and readable text on the dark background. So
 * `primary` is split: fills (`bg-primary`) use `--c-primary`, while text, borders,
 * rings, underlines and icon strokes use `--c-primary-fg`. Text on a primary fill
 * uses `on-primary`. On desktop the two match, so nothing changes there.
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
        /** Text on primary/sky: #0E0D12 in both themes. */
        "on-accent": token("on-accent"),
        /** Text on a solid primary fill: the dark ink on desktop's teal, white on phones' purple. */
        "on-primary": token("on-primary"),
        /** Modal and drawer backdrops. */
        scrim: token("scrim"),
      },
      // Primary as a foreground (see above): readable lilac on phones, the same teal elsewhere.
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
