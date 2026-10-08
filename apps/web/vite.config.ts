import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: "dist", assetsDir: "assets", sourcemap: false },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
