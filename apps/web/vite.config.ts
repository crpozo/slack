import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Vendor code in chunks of its own: their hashes survive app-only deploys,
        // so returning browsers download just the (small) app chunk.
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          amplify: ["aws-amplify"],
          fullcalendar: [
            "@fullcalendar/core",
            "@fullcalendar/react",
            "@fullcalendar/daygrid",
            "@fullcalendar/timegrid",
            "@fullcalendar/interaction",
          ],
        },
      },
    },
  },
  test: {
    // `.test.tsx`: components rendered in jsdom (each such file opts in with `@vitest-environment jsdom`).
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
