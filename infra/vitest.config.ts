import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test synthesizes whole stacks; the first one in a file pays the cold start.
    testTimeout: 30_000,
  },
});
