import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AgentTemplateImportPackRequest } from "@paperclipai/shared";

const DEFAULT_AGENT_TEMPLATE_ROOT = new URL("../onboarding-assets/templates/", import.meta.url);

async function collectMarkdownFiles(rootPath: string, currentPath = rootPath): Promise<Array<{ path: string; content: string }>> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const files: Array<{ path: string; content: string }> = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(rootPath, absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const lowerName = entry.name.toLowerCase();
    if (!lowerName.endsWith(".md") || lowerName === "readme.md" || lowerName.startsWith(".")) {
      continue;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    files.push({
      path: path.relative(rootPath, absolutePath).replaceAll(path.sep, "/"),
      content,
    });
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function loadDefaultAgentTemplatePack(): Promise<AgentTemplateImportPackRequest> {
  const rootPath = fileURLToPath(DEFAULT_AGENT_TEMPLATE_ROOT);
  const files = await collectMarkdownFiles(rootPath);
  return {
    rootPath: "server/src/onboarding-assets/templates",
    files: Object.fromEntries(files.map((entry) => [entry.path, entry.content])),
  };
}
