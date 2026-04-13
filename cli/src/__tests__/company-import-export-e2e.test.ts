import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createStoredZipArchive } from "./helpers/zip.js";

const execFileAsync = promisify(execFile);
type ServerProcess = ReturnType<typeof spawn>;

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company import/export e2e tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function writeTestConfig(configPath: string, tempRoot: string, port: number, connectionString: string) {
  const config = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "doctor",
    },
    database: {
      mode: "postgres",
      connectionString,
      embeddedPostgresDataDir: path.join(tempRoot, "embedded-db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: false,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(tempRoot, "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(tempRoot, "logs"),
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port,
      allowedHostnames: [],
      serveUi: false,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(tempRoot, "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(tempRoot, "secrets", "master.key"),
      },
    },
  };

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function createServerEnv(configPath: string, port: number, connectionString: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }
  delete env.DATABASE_URL;
  delete env.PORT;
  delete env.HOST;
  delete env.SERVE_UI;
  delete env.HEARTBEAT_SCHEDULER_ENABLED;

  env.PAPERCLIP_CONFIG = configPath;
  env.DATABASE_URL = connectionString;
  env.HOST = "127.0.0.1";
  env.PORT = String(port);
  env.SERVE_UI = "false";
  env.PAPERCLIP_DB_BACKUP_ENABLED = "false";
  env.HEARTBEAT_SCHEDULER_ENABLED = "false";
  env.PAPERCLIP_MIGRATION_AUTO_APPLY = "true";
  env.PAPERCLIP_UI_DEV_MIDDLEWARE = "false";

  return env;
}

function createCliEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }
  delete env.DATABASE_URL;
  delete env.PORT;
  delete env.HOST;
  delete env.SERVE_UI;
  delete env.PAPERCLIP_DB_BACKUP_ENABLED;
  delete env.HEARTBEAT_SCHEDULER_ENABLED;
  delete env.PAPERCLIP_MIGRATION_AUTO_APPLY;
  delete env.PAPERCLIP_UI_DEV_MIDDLEWARE;
  return env;
}

function collectTextFiles(root: string, current: string, files: Record<string, string>) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectTextFiles(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
    files[relativePath] = readFileSync(absolutePath, "utf8");
  }
}

async function stopServerProcess(child: ServerProcess | null) {
  if (!child || child.exitCode !== null) return;
  const processGroupId =
    process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0 ? child.pid : null;

  try {
    if (processGroupId) {
      process.kill(-processGroupId, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    return;
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const groupStillAlive =
      processGroupId && process.platform !== "win32"
        ? (() => {
          try {
            process.kill(-processGroupId, 0);
            return true;
          } catch {
            return false;
          }
        })()
        : child.exitCode === null;

    if (!groupStillAlive) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    if (processGroupId) {
      process.kill(-processGroupId, "SIGKILL");
    } else if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  } catch {
    // Ignore shutdown races in test cleanup.
  }
}

async function api<T>(baseUrl: string, pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${pathname}`, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Request failed ${res.status} ${pathname}: ${text}`);
  }
  return text ? JSON.parse(text) as T : (null as T);
}

async function runCliJson<T>(args: string[], opts: { apiBase: string; configPath: string }) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const result = await execFileAsync(
    "pnpm",
    ["--silent", "paperclipai", ...args, "--api-base", opts.apiBase, "--config", opts.configPath, "--json"],
    {
      cwd: repoRoot,
      env: createCliEnv(),
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const stdout = result.stdout.trim();
  const jsonStart = stdout.search(/[\[{]/);
  if (jsonStart === -1) {
    throw new Error(`CLI did not emit JSON.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return JSON.parse(stdout.slice(jsonStart)) as T;
}

async function waitForServer(
  apiBase: string,
  child: ServerProcess,
  output: { stdout: string[]; stderr: string[] },
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (child.exitCode !== null) {
      throw new Error(
        `test server exited before healthcheck succeeded.\nstdout:\n${output.stdout.join("")}\nstderr:\n${output.stderr.join("")}`,
      );
    }

    try {
      const res = await fetch(`${apiBase}/api/health`);
      if (res.ok) return;
    } catch {
      // Server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for ${apiBase}/api/health.\nstdout:\n${output.stdout.join("")}\nstderr:\n${output.stderr.join("")}`,
  );
}

describeEmbeddedPostgres("paperclipai company import/export e2e", () => {
  let tempRoot = "";
  let configPath = "";
  let exportDir = "";
  let apiBase = "";
  let serverProcess: ServerProcess | null = null;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-company-cli-e2e-"));
    configPath = path.join(tempRoot, "config", "config.json");
    exportDir = path.join(tempRoot, "exported-company");

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-cli-db-");

    const port = await getAvailablePort();
    writeTestConfig(configPath, tempRoot, port, tempDb.connectionString);
    apiBase = `http://127.0.0.1:${port}`;

    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const tsxCliPath = path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "cli.mjs");
    const serverEntryPath = path.join(repoRoot, "server", "src", "index.ts");
    const output = { stdout: [] as string[], stderr: [] as string[] };
    const child = spawn(
      process.execPath,
      [tsxCliPath, serverEntryPath],
      {
        cwd: repoRoot,
        env: createServerEnv(configPath, port, tempDb.connectionString),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    serverProcess = child;
    child.stdout?.on("data", (chunk) => {
      output.stdout.push(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      output.stderr.push(String(chunk));
    });

    await waitForServer(apiBase, child, output);
  }, 60_000);

  afterAll(async () => {
    await stopServerProcess(serverProcess);
    await tempDb?.cleanup();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("exports a company package and imports it into new and existing companies", async () => {
    expect(serverProcess).not.toBeNull();

    const sourceCompany = await api<{ id: string; name: string; issuePrefix: string }>(apiBase, "/api/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `CLI Export Source ${Date.now()}` }),
    });

    const sourceAgent = await api<{ id: string; name: string }>(
      apiBase,
      `/api/companies/${sourceCompany.id}/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Export Engineer",
          role: "engineer",
          adapterType: "claude_local",
          adapterConfig: {
            promptTemplate: "You verify company portability.",
          },
        }),
      },
    );

    const sourceProject = await api<{ id: string; name: string }>(
      apiBase,
      `/api/companies/${sourceCompany.id}/projects`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Portability Verification",
          status: "in_progress",
        }),
      },
    );

    const largeIssueDescription = `Round-trip the company package through the CLI.\n\n${"portable-data ".repeat(12_000)}`;

    const sourceIssue = await api<{ id: string; title: string; identifier: string }>(
      apiBase,
      `/api/companies/${sourceCompany.id}/issues`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Validate company import/export",
          description: largeIssueDescription,
          status: "todo",
          projectId: sourceProject.id,
          assigneeAgentId: sourceAgent.id,
        }),
      },
    );

    const exportResult = await runCliJson<{
      ok: boolean;
      out: string;
      filesWritten: number;
    }>(
      [
        "company",
        "export",
        sourceCompany.id,
        "--out",
        exportDir,
        "--include",
        "company,agents,projects,issues",
      ],
      { apiBase, configPath },
    );

    expect(exportResult.ok).toBe(true);
    expect(exportResult.filesWritten).toBeGreaterThan(0);
    expect(readFileSync(path.join(exportDir, "COMPANY.md"), "utf8")).toContain(sourceCompany.name);
    expect(readFileSync(path.join(exportDir, ".paperclip.yaml"), "utf8")).toContain('schema: "paperclip/v1"');

    const importedNew = await runCliJson<{
      company: { id: string; name: string; action: string };
      agents: Array<{ id: string | null; action: string; name: string }>;
    }>(
      [
        "company",
        "import",
        exportDir,
        "--target",
        "new",
        "--new-company-name",
        `Imported ${sourceCompany.name}`,
        "--include",
        "company,agents,projects,issues",
        "--yes",
      ],
      { apiBase, configPath },
    );

    expect(importedNew.company.action).toBe("created");
    expect(importedNew.agents).toHaveLength(1);
    expect(importedNew.agents[0]?.action).toBe("created");

    const importedAgents = await api<Array<{ id: string; name: string }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/agents`,
    );
    const importedProjects = await api<Array<{ id: string; name: string }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/projects`,
    );
    const importedIssues = await api<Array<{ id: string; title: string; identifier: string }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/issues`,
    );

    expect(importedAgents.map((agent) => agent.name)).toContain(sourceAgent.name);
    expect(importedProjects.map((project) => project.name)).toContain(sourceProject.name);
    expect(importedIssues.map((issue) => issue.title)).toContain(sourceIssue.title);

    const previewExisting = await runCliJson<{
      errors: string[];
      plan: {
        companyAction: string;
        agentPlans: Array<{ action: string }>;
        projectPlans: Array<{ action: string }>;
        issuePlans: Array<{ action: string }>;
      };
    }>(
      [
        "company",
        "import",
        exportDir,
        "--target",
        "existing",
        "--company-id",
        importedNew.company.id,
        "--include",
        "company,agents,projects,issues",
        "--collision",
        "rename",
        "--dry-run",
      ],
      { apiBase, configPath },
    );

    expect(previewExisting.errors).toEqual([]);
    expect(previewExisting.plan.companyAction).toBe("none");
    expect(previewExisting.plan.agentPlans.some((plan) => plan.action === "create")).toBe(true);
    expect(previewExisting.plan.projectPlans.some((plan) => plan.action === "create")).toBe(true);
    expect(previewExisting.plan.issuePlans.some((plan) => plan.action === "create")).toBe(true);

    const importedExisting = await runCliJson<{
      company: { id: string; action: string };
      agents: Array<{ id: string | null; action: string; name: string }>;
    }>(
      [
        "company",
        "import",
        exportDir,
        "--target",
        "existing",
        "--company-id",
        importedNew.company.id,
        "--include",
        "company,agents,projects,issues",
        "--collision",
        "rename",
        "--yes",
      ],
      { apiBase, configPath },
    );

    expect(importedExisting.company.action).toBe("unchanged");
    expect(importedExisting.agents.some((agent) => agent.action === "created")).toBe(true);

    const twiceImportedAgents = await api<Array<{ id: string; name: string }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/agents`,
    );
    const twiceImportedProjects = await api<Array<{ id: string; name: string }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/projects`,
    );
    const twiceImportedIssues = await api<Array<{ id: string; title: string; identifier: string }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/issues`,
    );

    expect(twiceImportedAgents).toHaveLength(2);
    expect(new Set(twiceImportedAgents.map((agent) => agent.name)).size).toBe(2);
    expect(twiceImportedProjects).toHaveLength(2);
    expect(twiceImportedIssues).toHaveLength(2);

    const zipPath = path.join(tempRoot, "exported-company.zip");
    const portableFiles: Record<string, string> = {};
    collectTextFiles(exportDir, exportDir, portableFiles);
    writeFileSync(zipPath, createStoredZipArchive(portableFiles, "paperclip-demo"));

    const importedFromZip = await runCliJson<{
      company: { id: string; name: string; action: string };
      agents: Array<{ id: string | null; action: string; name: string }>;
    }>(
      [
        "company",
        "import",
        zipPath,
        "--target",
        "new",
        "--new-company-name",
        `Zip Imported ${sourceCompany.name}`,
        "--include",
        "company,agents,projects,issues",
        "--yes",
      ],
      { apiBase, configPath },
    );

    expect(importedFromZip.company.action).toBe("created");
    expect(importedFromZip.agents.some((agent) => agent.action === "created")).toBe(true);
  }, 60_000);

  it("round-trips all agent, project, and issue fields faithfully", async () => {
    expect(serverProcess).not.toBeNull();

    const fidelityExportDir = path.join(tempRoot, "fidelity-export");
    mkdirSync(fidelityExportDir, { recursive: true });

    // --- Create a richly-populated source company ---
    const sourceCompany = await api<{
      id: string;
      name: string;
      issuePrefix: string;
      brandColor: string | null;
      description: string | null;
      requireBoardApprovalForNewAgents: boolean;
    }>(apiBase, "/api/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `Fidelity Test ${Date.now()}`,
        description: "Company for round-trip fidelity testing",
        brandColor: "#ff5500",
        requireBoardApprovalForNewAgents: true,
      }),
    });

    // Create a manager agent first so we can test reportsTo
    const managerAgent = await api<{ id: string; name: string }>(
      apiBase,
      `/api/companies/${sourceCompany.id}/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "CTO",
          role: "cto",
          title: "Chief Technology Officer",
          icon: "brain",
          capabilities: "Technical leadership and architecture",
          adapterType: "claude_local",
          adapterConfig: {
            model: "claude-opus-4-6",
          },
          budgetMonthlyCents: 50000,
          permissions: { canCreateAgents: true },
          metadata: { team: "leadership", level: "c-suite" },
        }),
      },
    );

    // Create an engineer agent that reports to the CTO
    const engineerAgent = await api<{ id: string; name: string }>(
      apiBase,
      `/api/companies/${sourceCompany.id}/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Backend Engineer",
          role: "engineer",
          title: "Senior Backend Engineer",
          icon: "code",
          capabilities: "Writes backend services and APIs",
          reportsTo: managerAgent.id,
          adapterType: "claude_local",
          adapterConfig: {
            model: "claude-sonnet-4-6",
          },
          runtimeConfig: {
            heartbeat: { intervalSec: 1800 },
          },
          budgetMonthlyCents: 10000,
          permissions: { canCreateAgents: false },
          metadata: { team: "backend", specialization: "api-design" },
        }),
      },
    );

    // Create a project with description
    const sourceProject = await api<{ id: string; name: string; urlKey: string }>(
      apiBase,
      `/api/companies/${sourceCompany.id}/projects`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "API Platform",
          description: "Core API platform project for building the main service layer",
          status: "in_progress",
          color: "#00cc88",
          leadAgentId: managerAgent.id,
        }),
      },
    );

    // Create issues with various field combinations
    const highPriorityIssue = await api<{
      id: string;
      title: string;
      identifier: string;
      description: string;
      status: string;
      priority: string;
    }>(apiBase, `/api/companies/${sourceCompany.id}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Implement auth middleware",
        description: "Build JWT-based authentication middleware with refresh token support.\n\nRequirements:\n- Token validation\n- Refresh flow\n- Rate limiting",
        status: "todo",
        priority: "high",
        projectId: sourceProject.id,
        assigneeAgentId: engineerAgent.id,
      }),
    });

    const lowPriorityIssue = await api<{
      id: string;
      title: string;
      identifier: string;
    }>(apiBase, `/api/companies/${sourceCompany.id}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Add OpenAPI docs",
        description: "Generate OpenAPI 3.1 documentation from route definitions",
        status: "backlog",
        priority: "low",
        projectId: sourceProject.id,
      }),
    });

    // --- Export the company ---
    const exportResult = await runCliJson<{
      ok: boolean;
      out: string;
      filesWritten: number;
    }>(
      [
        "company", "export", sourceCompany.id,
        "--out", fidelityExportDir,
        "--include", "company,agents,projects,issues",
      ],
      { apiBase, configPath },
    );
    expect(exportResult.ok).toBe(true);

    // --- Import into a new company ---
    const importResult = await runCliJson<{
      company: { id: string; name: string; action: string };
      agents: Array<{ id: string | null; action: string; name: string; slug: string }>;
      projects: Array<{ id: string | null; action: string; name: string }>;
      issues: Array<{ id: string | null; action: string; title: string }>;
    }>(
      [
        "company", "import", fidelityExportDir,
        "--target", "new",
        "--new-company-name", `Imported Fidelity ${Date.now()}`,
        "--include", "company,agents,projects,issues",
        "--yes",
      ],
      { apiBase, configPath },
    );

    expect(importResult.company.action).toBe("created");
    const targetCompanyId = importResult.company.id;

    // --- Fetch and verify all imported entities at field level ---

    // Verify company metadata
    const importedCompany = await api<{
      id: string;
      name: string;
      description: string | null;
      brandColor: string | null;
      requireBoardApprovalForNewAgents: boolean;
    }>(apiBase, `/api/companies/${targetCompanyId}`);

    expect(importedCompany.description).toBe(sourceCompany.description);
    expect(importedCompany.brandColor).toBe(sourceCompany.brandColor);
    expect(importedCompany.requireBoardApprovalForNewAgents).toBe(sourceCompany.requireBoardApprovalForNewAgents);

    // Verify agents
    const importedAgents = await api<Array<{
      id: string;
      name: string;
      role: string;
      title: string | null;
      icon: string | null;
      capabilities: string | null;
      reportsTo: string | null;
      adapterType: string;
      adapterConfig: Record<string, unknown>;
      runtimeConfig: Record<string, unknown> | null;
      budgetMonthlyCents: number;
      permissions: Record<string, unknown> | null;
      metadata: Record<string, unknown> | null;
    }>>(apiBase, `/api/companies/${targetCompanyId}/agents`);

    // Find the imported CTO and Engineer by name
    const importedCto = importedAgents.find((a) => a.name === "CTO");
    const importedEngineer = importedAgents.find((a) => a.name === "Backend Engineer");

    expect(importedCto).toBeDefined();
    expect(importedEngineer).toBeDefined();

    // CTO field checks
    expect(importedCto!.role).toBe("cto");
    expect(importedCto!.title).toBe("Chief Technology Officer");
    expect(importedCto!.icon).toBe("brain");
    expect(importedCto!.capabilities).toBe("Technical leadership and architecture");
    expect(importedCto!.adapterType).toBe("claude_local");
    expect(importedCto!.adapterConfig).toHaveProperty("model", "claude-opus-4-6");
    expect(importedCto!.budgetMonthlyCents).toBe(50000);
    expect(importedCto!.permissions).toMatchObject({ canCreateAgents: true });
    expect(importedCto!.metadata).toMatchObject({ team: "leadership", level: "c-suite" });

    // Engineer field checks
    expect(importedEngineer!.role).toBe("engineer");
    expect(importedEngineer!.title).toBe("Senior Backend Engineer");
    expect(importedEngineer!.icon).toBe("code");
    expect(importedEngineer!.capabilities).toBe("Writes backend services and APIs");
    expect(importedEngineer!.adapterType).toBe("claude_local");
    expect(importedEngineer!.adapterConfig).toHaveProperty("model", "claude-sonnet-4-6");
    expect(importedEngineer!.budgetMonthlyCents).toBe(10000);
    expect(importedEngineer!.permissions).toMatchObject({ canCreateAgents: false });
    expect(importedEngineer!.metadata).toMatchObject({ team: "backend", specialization: "api-design" });

    // Engineer should report to the imported CTO
    expect(importedEngineer!.reportsTo).toBe(importedCto!.id);

    // Timer heartbeat should be disabled on import
    const heartbeatConfig = (importedEngineer!.runtimeConfig as any)?.heartbeat;
    if (heartbeatConfig) {
      expect(heartbeatConfig.enabled).toBe(false);
    }

    // Verify project fields
    const importedProjects = await api<Array<{
      id: string;
      name: string;
      description: string | null;
      status: string;
      color: string | null;
      leadAgentId: string | null;
    }>>(apiBase, `/api/companies/${targetCompanyId}/projects`);

    const importedProject = importedProjects.find((p) => p.name === "API Platform");
    expect(importedProject).toBeDefined();
    expect(importedProject!.description).toBe("Core API platform project for building the main service layer");
    expect(importedProject!.status).toBe("in_progress");
    expect(importedProject!.color).toBe("#00cc88");
    // Lead agent should be mapped to the imported CTO
    expect(importedProject!.leadAgentId).toBe(importedCto!.id);

    // Verify issue fields
    const importedIssues = await api<Array<{
      id: string;
      title: string;
      identifier: string;
      description: string | null;
      status: string;
      priority: string;
      projectId: string | null;
      assigneeAgentId: string | null;
    }>>(apiBase, `/api/companies/${targetCompanyId}/issues`);

    const importedAuthIssue = importedIssues.find((i) => i.title === "Implement auth middleware");
    const importedDocsIssue = importedIssues.find((i) => i.title === "Add OpenAPI docs");

    expect(importedAuthIssue).toBeDefined();
    expect(importedDocsIssue).toBeDefined();

    // High-priority issue field checks
    expect(importedAuthIssue!.description).toContain("JWT-based authentication middleware");
    expect(importedAuthIssue!.description).toContain("Rate limiting");
    expect(importedAuthIssue!.priority).toBe("high");
    expect(importedAuthIssue!.projectId).toBe(importedProject!.id);
    expect(importedAuthIssue!.assigneeAgentId).toBe(importedEngineer!.id);

    // Low-priority issue field checks
    expect(importedDocsIssue!.description).toContain("OpenAPI 3.1");
    expect(importedDocsIssue!.priority).toBe("low");
    expect(importedDocsIssue!.projectId).toBe(importedProject!.id);
  }, 60_000);
});
