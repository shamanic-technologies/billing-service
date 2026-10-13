import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts", "./tests/setup-runs-absorbed.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
