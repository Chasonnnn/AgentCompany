import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-claude-local/server";

const ORIGINAL_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK;
const ORIGINAL_BEDROCK_URL = process.env.ANTHROPIC_BEDROCK_BASE_URL;

afterEach(() => {
  if (ORIGINAL_ANTHROPIC === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC;
  }
  if (ORIGINAL_BEDROCK === undefined) {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
  } else {
    process.env.CLAUDE_CODE_USE_BEDROCK = ORIGINAL_BEDROCK;
  }
  if (ORIGINAL_BEDROCK_URL === undefined) {
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
  } else {
    process.env.ANTHROPIC_BEDROCK_BASE_URL = ORIGINAL_BEDROCK_URL;
  }
});

async function setupFakeClaudeCli(root: string) {
  const binDir = path.join(root, "bin");
  const cwd = path.join(root, "workspace");
  const fakeClaude = path.join(binDir, "claude");
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"max\"}'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"--print\" ]; then",
    "  echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"session-1\",\"model\":\"claude-opus-4-6\"}'",
    "  echo '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Hello.\"}]},\"session_id\":\"session-1\"}'",
    "  echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"session-1\",\"result\":\"Hello.\",\"usage\":{\"input_tokens\":1,\"cache_read_input_tokens\":0,\"output_tokens\":1}}'",
    "  exit 0",
    "fi",
    "echo \"unexpected args: $*\" >&2",
    "exit 1",
    "",
  ].join("\n");

  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(fakeClaude, script, "utf8");
  await fs.chmod(fakeClaude, 0o755);

  return {
    cwd,
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: root,
    },
  };
}

describe("claude_local environment diagnostics", () => {
  it("returns a warning (not an error) when ANTHROPIC_API_KEY is set in host environment", async () => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    process.env.ANTHROPIC_API_KEY = "sk-test-host";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
      },
    });

    expect(result.status).toBe("warn");
    expect(
      result.checks.some(
        (check) =>
          check.code === "claude_anthropic_api_key_overrides_subscription" &&
          check.level === "warn",
      ),
    ).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
  });

  it("returns a warning (not an error) when ANTHROPIC_API_KEY is set in adapter env", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
        env: {
          ANTHROPIC_API_KEY: "sk-test-config",
        },
      },
    });

    expect(result.status).toBe("warn");
    expect(
      result.checks.some(
        (check) =>
          check.code === "claude_anthropic_api_key_overrides_subscription" &&
          check.level === "warn",
      ),
    ).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
  });

  it("returns bedrock auth info when CLAUDE_CODE_USE_BEDROCK is set in host environment", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
      },
    });

    expect(
      result.checks.some(
        (check) =>
          check.code === "claude_bedrock_auth" && check.level === "info",
      ),
    ).toBe(true);
    expect(
      result.checks.some(
        (check) => check.code === "claude_subscription_mode_possible",
      ),
    ).toBe(false);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
  });

  it("returns bedrock auth info when CLAUDE_CODE_USE_BEDROCK is set in adapter env", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
        },
      },
    });

    expect(
      result.checks.some(
        (check) =>
          check.code === "claude_bedrock_auth" && check.level === "info",
      ),
    ).toBe(true);
    expect(
      result.checks.some(
        (check) => check.code === "claude_subscription_mode_possible",
      ),
    ).toBe(false);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
  });

  it("bedrock auth takes precedence over missing ANTHROPIC_API_KEY", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
      },
    });

    const codes = result.checks.map((c) => c.code);
    expect(codes).toContain("claude_bedrock_auth");
    expect(codes).not.toContain("claude_subscription_mode_possible");
    expect(codes).not.toContain("claude_anthropic_api_key_overrides_subscription");
  });

  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-claude-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "claude_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("trusts `claude auth status` when the CLI reports a logged-in subscription session", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-claude-auth-status-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

    try {
      const fakeCli = await setupFakeClaudeCli(root);

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "claude_local",
        config: {
          command: "claude",
          cwd: fakeCli.cwd,
          env: fakeCli.env,
        },
      });

      expect(result.checks.some((check) => check.code === "claude_native_auth_present")).toBe(true);
      expect(result.checks.some((check) => check.code === "claude_subscription_mode_possible")).toBe(false);
      expect(result.checks.some((check) => check.code === "claude_hello_probe_passed")).toBe(true);
      expect(result.checks.some((check) => check.code === "claude_skip_auto_permission_prompt_enabled")).toBe(false);
      expect(result.status).toBe("pass");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("warns when Claude settings disable native permission prompts", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-claude-skip-auto-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

    try {
      const fakeCli = await setupFakeClaudeCli(root);
      await fs.mkdir(path.join(root, ".claude"), { recursive: true });
      await fs.writeFile(
        path.join(root, ".claude", "settings.json"),
        JSON.stringify({ skipAutoPermissionPrompt: true }, null, 2),
        "utf8",
      );

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "claude_local",
        config: {
          command: "claude",
          cwd: fakeCli.cwd,
          env: fakeCli.env,
        },
      });

      const warning = result.checks.find((check) => check.code === "claude_skip_auto_permission_prompt_enabled");
      expect(warning?.level).toBe("warn");
      expect(warning?.detail).toBe(path.join(root, ".claude", "settings.json"));
      expect(warning?.hint).toContain("POST /api/issues/:issueId/questions");
      expect(result.status).toBe("warn");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a missing Claude settings.json file", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-claude-missing-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

    try {
      const fakeCli = await setupFakeClaudeCli(root);
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "claude_local",
        config: {
          command: "claude",
          cwd: fakeCli.cwd,
          env: fakeCli.env,
        },
      });

      expect(result.checks.some((check) => check.code === "claude_skip_auto_permission_prompt_enabled")).toBe(false);
      expect(result.status).toBe("pass");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a malformed Claude settings.json file", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-claude-bad-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

    try {
      const fakeCli = await setupFakeClaudeCli(root);
      await fs.mkdir(path.join(root, ".claude"), { recursive: true });
      await fs.writeFile(path.join(root, ".claude", "settings.json"), "{ not-json", "utf8");

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "claude_local",
        config: {
          command: "claude",
          cwd: fakeCli.cwd,
          env: fakeCli.env,
        },
      });

      expect(result.checks.some((check) => check.code === "claude_skip_auto_permission_prompt_enabled")).toBe(false);
      expect(result.status).toBe("pass");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("defaults remote probes to the environment remote cwd when adapter cwd is unset", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
      },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "test-provider",
        remoteCwd: "/srv/paperclip/workspace",
        runner: {
          execute: async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            pid: null,
            startedAt: new Date().toISOString(),
          }),
        },
      },
      environmentName: "Linux Box",
    });

    expect(result.checks.some((check) => check.code === "claude_cwd_valid")).toBe(true);
    expect(
      result.checks.some(
        (check) =>
          check.code === "claude_cwd_valid" &&
          check.message === "Working directory is valid: /srv/paperclip/workspace",
      ),
    ).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_cwd_invalid")).toBe(false);
  });
});
