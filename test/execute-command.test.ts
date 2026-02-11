import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { executeCommandRun } from "../src/runtime/execute_command.js";
import { readYamlFile } from "../src/store/yaml.js";
import { RunYaml } from "../src/schemas/run.js";

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
  return dir;
}

async function readJsonl(filePath: string): Promise<any[]> {
  const s = await fs.readFile(filePath, { encoding: "utf8" });
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

describe("executeCommandRun", () => {
  test("streams provider.raw and marks run ended on exit code 0", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });

    const res = await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id,
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('hello\\n'); process.stderr.write('oops\\n');"
      ]
    });
    expect(res.exit_code).toBe(0);

    const runYamlPath = path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml");
    const runDoc = RunYaml.parse(await readYamlFile(runYamlPath));
    expect(runDoc.status).toBe("ended");
    expect(runDoc.spec?.kind).toBe("command");
    expect(runDoc.usage?.source).toBe("estimated_chars");
    expect(runDoc.usage?.total_tokens).toBeGreaterThan(0);

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    const evs = await readJsonl(eventsPath);
    expect(evs.some((e) => e.type === "run.started")).toBe(true);
    expect(evs.some((e) => e.type === "run.executing")).toBe(true);
    expect(
      evs.some((e) => e.type === "provider.raw" && e.payload?.stream === "stdout" && String(e.payload?.chunk).includes("hello"))
    ).toBe(true);
    expect(
      evs.some((e) => e.type === "provider.raw" && e.payload?.stream === "stderr" && String(e.payload?.chunk).includes("oops"))
    ).toBe(true);
    expect(evs.some((e) => e.type === "usage.estimated")).toBe(true);
    expect(evs.some((e) => e.type === "run.ended")).toBe(true);
  });

  test("stores stdin_text in outputs and records stdin_relpath in run spec", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });

    const stdinText = "hello-from-stdin\n";
    const res = await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id,
      argv: [
        process.execPath,
        "-e",
        "let d=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>process.stdout.write(d));"
      ],
      stdin_text: stdinText
    });
    expect(res.exit_code).toBe(0);

    const runYamlPath = path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml");
    const runDoc = RunYaml.parse(await readYamlFile(runYamlPath));
    expect(runDoc.spec?.stdin_relpath).toBe(`runs/${run_id}/outputs/stdin.txt`);

    const stdinPath = path.join(dir, "work/projects", project_id, "runs", run_id, "outputs", "stdin.txt");
    const stored = await fs.readFile(stdinPath, { encoding: "utf8" });
    expect(stored).toBe(stdinText);
  });

  test("marks run failed on non-zero exit code", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });

    const res = await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id,
      argv: [process.execPath, "-e", "process.exit(5);"]
    });
    expect(res.exit_code).toBe(5);

    const runYamlPath = path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml");
    const runDoc = RunYaml.parse(await readYamlFile(runYamlPath));
    expect(runDoc.status).toBe("failed");

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    const evs = await readJsonl(eventsPath);
    expect(evs.some((e) => e.type === "run.failed")).toBe(true);
  });

  test("captures provider-reported token usage from JSONL output", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "codex" });

    const res = await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id,
      argv: [
        process.execPath,
        "-e",
        [
          "const obj={type:'turn.completed',tokenUsage:{input_tokens:100,output_tokens:20,cached_input_tokens:10,reasoning_output_tokens:5,total_tokens:135}};",
          "process.stdout.write(JSON.stringify(obj)+'\\n');"
        ].join("")
      ]
    });
    expect(res.exit_code).toBe(0);

    const runYamlPath = path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml");
    const runDoc = RunYaml.parse(await readYamlFile(runYamlPath));
    expect(runDoc.usage?.source).toBe("provider_reported");
    expect(runDoc.usage?.confidence).toBe("high");
    expect(runDoc.usage?.total_tokens).toBe(135);
    expect(runDoc.usage?.input_tokens).toBe(100);
    expect(runDoc.usage?.output_tokens).toBe(20);

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    const evs = await readJsonl(eventsPath);
    expect(evs.some((e) => e.type === "usage.reported" && e.payload?.total_tokens === 135)).toBe(true);
    expect(evs.some((e) => e.type === "usage.estimated")).toBe(false);
  });
});
