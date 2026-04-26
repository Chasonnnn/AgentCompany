import fs from "node:fs/promises";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md", "MEMORY.md"],
  manager: ["AGENTS.md", "MEMORY.md", "HEARTBEAT.md"],
  ceo: ["AGENTS.md", "MEMORY.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;

export const CANONICAL_AGENT_MEMORY_CONTRACT_HEADING = "## Paperclip Managed Memory";

export const CANONICAL_AGENT_MEMORY_CONTRACT = [
  CANONICAL_AGENT_MEMORY_CONTRACT_HEADING,
  "",
  "Paperclip-managed memory is the canonical durable memory surface for personal operating notes.",
  "",
  "- Read compact hot memory from `./MEMORY.md` when it exists; this file mirrors managed `hot/MEMORY.md` for prompt-time continuity.",
  "- Write durable self-memory through the authenticated Paperclip API, not by editing workspace-root `MEMORY.md` files.",
  "- Use `PAPERCLIP_AGENT_MEMORY_HOT_PATH` for the canonical hot-memory path and `PAPERCLIP_AGENT_MEMORY_API_PATH` for the write endpoint.",
  "- Include `Authorization: Bearer $PAPERCLIP_API_KEY`, `Content-Type: application/json`, and `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` when writing memory.",
  "- Keep hot memory under 8 KB when possible. Move daily continuity to `daily/YYYY-MM-DD.md`, recurring lessons to `operations/*.md`, and shared knowledge to company memory.",
  "- Keep issue-specific execution state in issue docs/comments, not memory.",
].join("\n");

export function withCanonicalAgentMemoryContract(body: string): string {
  if (body.includes(CANONICAL_AGENT_MEMORY_CONTRACT_HEADING)) return body;
  return `${body.trimEnd()}\n\n${CANONICAL_AGENT_MEMORY_CONTRACT}\n`;
}

function resolveDefaultAgentBundleUrl(role: DefaultAgentBundleRole, fileName: string) {
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

export async function loadDefaultAgentInstructionsBundle(role: DefaultAgentBundleRole): Promise<Record<string, string>> {
  const fileNames = DEFAULT_AGENT_BUNDLE_FILES[role];
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await fs.readFile(resolveDefaultAgentBundleUrl(role, fileName), "utf8");
      return [fileName, fileName === "AGENTS.md" ? withCanonicalAgentMemoryContract(content) : content] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  if (role === "ceo") return "ceo";
  if (["cto", "cmo", "cfo", "coo", "pm"].includes(role)) return "manager";
  return "default";
}
