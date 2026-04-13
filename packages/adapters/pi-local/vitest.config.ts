import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: "../../../scripts/vitest-process-guard.mjs",
  },
});
