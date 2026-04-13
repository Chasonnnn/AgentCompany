import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    globalSetup: "../../../../scripts/vitest-process-guard.mjs",
  },
});
