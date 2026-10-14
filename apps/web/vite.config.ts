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
        },
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
