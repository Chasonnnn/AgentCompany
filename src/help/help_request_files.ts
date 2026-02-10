import path from "node:path";
import { writeFileAtomic } from "../store/fs.js";
import { newHelpRequestMarkdown, type NewHelpRequestArgs, validateHelpRequestMarkdown } from "./help_request.js";

export async function createHelpRequestFile(
  workspaceDir: string,
  args: NewHelpRequestArgs
): Promise<{ help_request_id: string; file_path: string }> {
  const { help_request_id, markdown } = newHelpRequestMarkdown(args);
  const validated = validateHelpRequestMarkdown(markdown);
  if (!validated.ok) {
    const msg = validated.issues.map((i) => i.message).join("; ");
    throw new Error(`Internal error: generated invalid help request markdown: ${msg}`);
  }

  const rel = path.join("inbox/help_requests", `${help_request_id}.md`);
  const abs = path.join(workspaceDir, rel);
  await writeFileAtomic(abs, markdown);
  return { help_request_id, file_path: abs };
}

