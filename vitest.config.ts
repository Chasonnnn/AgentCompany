import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/shared",
      "packages/db",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "evals",
      "server",
      "ui",
      "cli",
      "desktop",
    ],
  },
});
