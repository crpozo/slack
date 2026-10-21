// @ts-check

/** Token backed by a CSS variable holding "R G B", so Tailwind's opacity modifiers keep working. */
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

/**
 * MindfulTech design system. Values live in src/styles.css as CSS variables
 * with a light set on :root and a dark set on .dark, so every utility
 * (bg-surface, text-ink, bg-primary/15…) switches theme without `dark:` variants.
 * Contrast: primary (#69C7B9) and sky (#85BFE9) are light in both themes, so text on
 * them uses `on-accent` (always the dark ink), never white.
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
        /** Modal and drawer backdrops. */
        scrim: token("scrim"),
      },
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
