import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { ensureLocalTrustedAgentJwtSecret } from "../local-trusted-agent-jwt.js";

describe("ensureLocalTrustedAgentJwtSecret", () => {
  const originalPaperclipConfig = process.env.PAPERCLIP_CONFIG;
  const originalAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalPaperclipConfig === undefined) delete process.env.PAPERCLIP_CONFIG;
    else process.env.PAPERCLIP_CONFIG = originalPaperclipConfig;

    if (originalAgentJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalAgentJwtSecret;

    if (originalBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;

    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempConfigPaths() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-local-trusted-jwt-"));
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, ".paperclip", "config.json");
    const envPath = path.join(tempDir, ".paperclip", ".env");
    process.env.PAPERCLIP_CONFIG = configPath;
    return { configPath, envPath };
  }

  it("creates and persists a secret when no env or env file exists", () => {
    const { envPath } = createTempConfigPaths();
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;

    const result = ensureLocalTrustedAgentJwtSecret();

    expect(result.status).toBe("created_env_file");
    expect(result.envPath).toBe(envPath);
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.readFileSync(envPath, "utf8")).toContain("PAPERCLIP_AGENT_JWT_SECRET=");
    expect(createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1")).toEqual(expect.any(String));
  });

  it("loads an existing secret from the instance env file", () => {
    const { configPath, envPath } = createTempConfigPaths();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(envPath, "HOST=127.0.0.1\nPAPERCLIP_AGENT_JWT_SECRET=file-secret\n", "utf8");
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;

    const result = ensureLocalTrustedAgentJwtSecret();

    expect(result.status).toBe("loaded_from_env_file");
    expect(result.envPath).toBe(envPath);
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("file-secret");
    expect(fs.readFileSync(envPath, "utf8")).toContain("HOST=127.0.0.1");
  });

  it("does not create a second secret when BETTER_AUTH_SECRET already exists", () => {
    const { envPath } = createTempConfigPaths();
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.BETTER_AUTH_SECRET = "better-auth-secret";

    const result = ensureLocalTrustedAgentJwtSecret();

    expect(result.status).toBe("using_better_auth_secret");
    expect(result.envPath).toBeNull();
    expect(fs.existsSync(envPath)).toBe(false);
  });
});
