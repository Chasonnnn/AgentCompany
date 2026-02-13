import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { setProviderBin } from "../src/machine/machine.js";
import { enforceSubscriptionExecutionPolicy } from "../src/runtime/subscription_guard.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function writeExecutable(dir: string, name: string): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(
    p,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in with ChatGPT\\n");
  process.exit(0);
}
process.stdout.write("ok\\n");
`,
    { encoding: "utf8", mode: 0o755 }
  );
  return p;
}

async function writeCodexLoginStatusUnknownMode(dir: string): Promise<string> {
  const p = path.join(dir, "codex");
  await fs.writeFile(
    p,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Auth mode: unknown\\n");
  process.exit(0);
}
process.stdout.write("ok\\n");
`,
    { encoding: "utf8", mode: 0o755 }
  );
  return p;
}

async function writeCodexLoginStatusApiKeyMode(dir: string): Promise<string> {
  const p = path.join(dir, "codex");
  await fs.writeFile(
    p,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Auth mode: API key\\n");
  process.exit(0);
}
process.stdout.write("ok\\n");
`,
    { encoding: "utf8", mode: 0o755 }
  );
  return p;
}

describe("subscription execution guard", () => {
  test("passes codex subscription proof when CLI bin is allowed and API key is absent", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const codexBin = await writeExecutable(dir, "codex");
    await setProviderBin(dir, "codex", codexBin);

    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await enforceSubscriptionExecutionPolicy({
        workspace_dir: dir,
        provider: "codex"
      });
      expect(res.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  test("fails closed when codex API key is present", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const codexBin = await writeExecutable(dir, "codex");
    await setProviderBin(dir, "codex", codexBin);

    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const res = await enforceSubscriptionExecutionPolicy({
        workspace_dir: dir,
        provider: "codex"
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("api_key_present");
      }
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  test("fails closed for unapproved binary names", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const weirdBin = await writeExecutable(dir, "my-custom-runner");
    await setProviderBin(dir, "codex", weirdBin);

    const res = await enforceSubscriptionExecutionPolicy({
      workspace_dir: dir,
      provider: "codex"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("unapproved_worker_binary");
    }
  });

  test("fails when codex auth probe reports API-key mode", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const codexBin = await writeCodexLoginStatusApiKeyMode(dir);
    await setProviderBin(dir, "codex", codexBin);

    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await enforceSubscriptionExecutionPolicy({
        workspace_dir: dir,
        provider: "codex"
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("auth_probe_failed");
      }
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  test("fails when codex auth probe does not report a subscription login mode", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const codexBin = await writeCodexLoginStatusUnknownMode(dir);
    await setProviderBin(dir, "codex", codexBin);

    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await enforceSubscriptionExecutionPolicy({
        workspace_dir: dir,
        provider: "codex"
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("auth_probe_failed");
      }
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  test("fails closed when claude API key is present", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const claudeBin = await writeExecutable(dir, "claude");
    await setProviderBin(dir, "claude", claudeBin);

    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const res = await enforceSubscriptionExecutionPolicy({
        workspace_dir: dir,
        provider: "claude"
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("api_key_present");
      }
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("passes gemini API channel when GEMINI_API_KEY is present", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const geminiBin = await writeExecutable(dir, "gemini");
    await setProviderBin(dir, "gemini", geminiBin);

    const prev = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    try {
      const res = await enforceSubscriptionExecutionPolicy({
        workspace_dir: dir,
        provider: "gemini"
      });
      expect(res.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });

  test("passes gemini API channel when GOOGLE_API_KEY is present", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const geminiBin = await writeExecutable(dir, "gemini");
    await setProviderBin(dir, "gemini", geminiBin);

    const prevGoogleApiKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = "test-key";
    try {
      const res = await enforceSubscriptionExecutionPolicy({
        workspace_dir: dir,
        provider: "gemini"
      });
      expect(res.ok).toBe(true);
    } finally {
      if (prevGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = prevGoogleApiKey;
    }
  });

  test("passes gemini API channel when Vertex AI env is configured", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const geminiBin = await writeExecutable(dir, "gemini");
    await setProviderBin(dir, "gemini", geminiBin);

    const prevUseVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    const prevProject = process.env.GOOGLE_CLOUD_PROJECT;
    const prevLocation = process.env.GOOGLE_CLOUD_LOCATION;
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
    process.env.GOOGLE_CLOUD_PROJECT = "acme-test";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
    try {
      const res = await enforceSubscriptionExecutionPolicy({
        workspace_dir: dir,
        provider: "gemini"
      });
      expect(res.ok).toBe(true);
    } finally {
      if (prevUseVertex === undefined) delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      else process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertex;
      if (prevProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = prevProject;
      if (prevLocation === undefined) delete process.env.GOOGLE_CLOUD_LOCATION;
      else process.env.GOOGLE_CLOUD_LOCATION = prevLocation;
    }
  });

  test("fails fast when gemini API channel has no credentials configured", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const geminiBin = await writeExecutable(dir, "gemini");
    await setProviderBin(dir, "gemini", geminiBin);

    const prevGeminiApiKey = process.env.GEMINI_API_KEY;
    const prevGoogleApiKey = process.env.GOOGLE_API_KEY;
    const prevUseVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    const prevProject = process.env.GOOGLE_CLOUD_PROJECT;
    const prevLocation = process.env.GOOGLE_CLOUD_LOCATION;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_LOCATION;
    try {
      const res = await enforceSubscriptionExecutionPolicy({
        workspace_dir: dir,
        provider: "gemini"
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("auth_probe_failed");
      }
    } finally {
      if (prevGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGeminiApiKey;
      if (prevGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = prevGoogleApiKey;
      if (prevUseVertex === undefined) delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      else process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertex;
      if (prevProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = prevProject;
      if (prevLocation === undefined) delete process.env.GOOGLE_CLOUD_LOCATION;
      else process.env.GOOGLE_CLOUD_LOCATION = prevLocation;
    }
  });

  test("fails closed for unapproved gemini binary names even when API key is present", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const weirdBin = await writeExecutable(dir, "my-custom-runner");
    await setProviderBin(dir, "gemini", weirdBin);

    const prev = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    try {
      const res = await enforceSubscriptionExecutionPolicy({
        workspace_dir: dir,
        provider: "gemini"
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("unapproved_worker_binary");
      }
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });
});
