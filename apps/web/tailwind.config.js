// @ts-check

/**
 * MindfulTech design system tokens.
 * Contrast note: primary (#69C7B9) and sky (#85BFE9) are light, so text on
 * them uses `ink`, never white.
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#69C7B9",
          hover: "#5AB3A6",
        },
        sky: {
          DEFAULT: "#85BFE9",
        },
        info: "#85BFE9",
        ink: {
          DEFAULT: "#0E0D12",
          secondary: "#4B4D55",
        },
        surface: {
          DEFAULT: "#FFFFFF",
          sidebar: "#F5F7F9",
          hover: "#E8EDF2",
        },
        line: "#E8EDF2",
        success: "#5FD4B2",
        warning: "#F4C95C",
        error: "#E57373",
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
        attachment: "320px",
      },
    },
  },
  plugins: [],
};
