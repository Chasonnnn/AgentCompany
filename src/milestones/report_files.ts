import path from "node:path";
import { writeFileAtomic } from "../store/fs.js";
import { newMilestoneReportMarkdown, type NewMilestoneReportArgs } from "./milestone_report.js";

export async function createMilestoneReportFile(
  workspaceDir: string,
  args: NewMilestoneReportArgs
): Promise<{ artifact_id: string; artifact_path: string }> {
  const { artifact_id, markdown } = newMilestoneReportMarkdown(args);
  const rel = path.join("work/projects", args.project_id, "artifacts", `${artifact_id}.md`);
  const abs = path.join(workspaceDir, rel);
  await writeFileAtomic(abs, markdown);
  return { artifact_id, artifact_path: abs };
}

