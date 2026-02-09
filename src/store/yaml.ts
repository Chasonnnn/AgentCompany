import fs from "node:fs/promises";
import YAML from "yaml";
import { writeFileAtomic } from "./fs.js";

export function yamlStringify(doc: unknown): string {
  // Keep YAML stable and human-friendly; avoid anchors.
  return YAML.stringify(doc, { aliasDuplicateObjects: false });
}

export async function writeYamlFile(filePath: string, doc: unknown): Promise<void> {
  const s = yamlStringify(doc);
  await writeFileAtomic(filePath, s);
}

export async function readYamlFile(filePath: string): Promise<unknown> {
  const s = await fs.readFile(filePath, { encoding: "utf8" });
  return YAML.parse(s);
}
