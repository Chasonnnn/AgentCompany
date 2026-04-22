import { useEffect, useMemo, useState, type SVGProps } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentDepartmentKey,
  CompanyAgentNavigation,
  BulkSkillGrantMode,
  BulkSkillGrantPreview,
  BulkSkillGrantRequest,
  BulkSkillGrantTier,
  CompanySkillCreateRequest,
  CompanySkillCoverageAudit,
  CompanySkillCoverageRepairPreview,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillHardeningState,
  CompanySkillListItem,
  CompanySkillProjectScanResult,
  CompanySkillReliabilityAudit,
  CompanySkillReliabilityRepairPreview,
  CompanySkillSourceBadge,
  CompanySkillUpdateStatus,
  GlobalSkillCatalogItem,
  GlobalSkillCatalogSourceRoot,
} from "@paperclipai/shared";
import { authApi } from "../api/auth";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { getPaperclipDesktopBridge } from "../lib/desktop";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Github,
  Link2,
  ExternalLink,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Workflow,
} from "lucide-react";

type SkillTreeNode = {
  name: string;
  path: string | null;
  kind: "dir" | "file";
  fileKind?: CompanySkillFileInventoryEntry["kind"];
  children: SkillTreeNode[];
};

const SKILL_TREE_BASE_INDENT = 16;
const SKILL_TREE_STEP_INDENT = 24;
const SKILL_TREE_ROW_HEIGHT_CLASS = "min-h-9";
const BULK_SKILL_GRANT_TIERS: Array<{ value: BulkSkillGrantTier; label: string }> = [
  { value: "all", label: "All" },
  { value: "leaders", label: "Leaders" },
  { value: "workers", label: "Workers" },
];
const BULK_SKILL_GRANT_MODES: Array<{
  value: BulkSkillGrantMode;
  label: string;
  description: string;
}> = [
  {
    value: "add",
    label: "Add",
    description: "Add this skill to each matched agent without removing other granted skills.",
  },
  {
    value: "remove",
    label: "Remove",
    description: "Remove this skill from each matched agent and leave other granted skills alone.",
  },
  {
    value: "replace",
    label: "Replace",
    description: "Replace every non-required granted skill on each matched agent with only this skill.",
  },
];

function VercelMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 4 21 19H3z" />
    </svg>
  );
}

function stripFrontmatter(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return normalized.trim();
  return normalized.slice(closing + 5).trim();
}

function sameStringArray(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function splitFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: null, body: normalized };
  }
  return {
    frontmatter: normalized.slice(4, closing).trim(),
    body: normalized.slice(closing + 5).trimStart(),
  };
}

function mergeFrontmatter(markdown: string, body: string) {
  const parsed = splitFrontmatter(markdown);
  if (!parsed.frontmatter) return body;
  return ["---", parsed.frontmatter, "---", "", body].join("\n");
}

function buildTree(entries: CompanySkillFileInventoryEntry[]) {
  const root: SkillTreeNode = { name: "", path: null, kind: "dir", children: [] };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (const [index, segment] of segments.entries()) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      let next = current.children.find((child) => child.name === segment);
      if (!next) {
        next = {
          name: segment,
          path: isLeaf ? entry.path : currentPath,
          kind: isLeaf ? "file" : "dir",
          fileKind: isLeaf ? entry.kind : undefined,
          children: [],
        };
        current.children.push(next);
      }
      current = next;
    }
  }

  function sortNode(node: SkillTreeNode) {
    node.children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
      if (left.name === "SKILL.md") return -1;
      if (right.name === "SKILL.md") return 1;
      return left.name.localeCompare(right.name);
    });
    node.children.forEach(sortNode);
  }

  sortNode(root);
  return root.children;
}

function sourceMeta(sourceBadge: CompanySkillSourceBadge, sourceLabel: string | null) {
  const normalizedLabel = sourceLabel?.toLowerCase() ?? "";
  const isSkillsShManaged =
    normalizedLabel.includes("skills.sh") || normalizedLabel.includes("vercel-labs/skills");

  switch (sourceBadge) {
    case "skills_sh":
      return { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: "skills.sh managed" };
    case "github":
      return isSkillsShManaged
        ? { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: "skills.sh managed" }
        : { icon: Github, label: sourceLabel ?? "GitHub", managedLabel: "GitHub managed" };
    case "url":
      return { icon: Link2, label: sourceLabel ?? "URL", managedLabel: "URL managed" };
    case "local":
      return { icon: Folder, label: sourceLabel ?? "Folder", managedLabel: "Folder managed" };
    case "paperclip":
      return { icon: Paperclip, label: sourceLabel ?? "Paperclip", managedLabel: "Paperclip managed" };
    default:
      return { icon: Boxes, label: sourceLabel ?? "Catalog", managedLabel: "Catalog managed" };
  }
}

function shortRef(ref: string | null | undefined) {
  if (!ref) return null;
  return ref.slice(0, 7);
}

function formatProjectScanSummary(result: CompanySkillProjectScanResult) {
  const parts = [
    `${result.discovered} found`,
    `${result.imported.length} imported`,
    `${result.updated.length} updated`,
  ];
  if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} conflicts`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  return `${parts.join(", ")} across ${result.scannedWorkspaces} workspace${result.scannedWorkspaces === 1 ? "" : "s"}.`;
}

function formatGlobalCatalogCount(count: number) {
  return `${count} discoverable`;
}

function globalCatalogSourceLabel(sourceRoot: GlobalSkillCatalogSourceRoot) {
  if (sourceRoot === "claude") return "Claude";
  if (sourceRoot === "agents") return "Agents";
  return "Codex";
}

function globalCatalogSourceClassName(sourceRoot: GlobalSkillCatalogSourceRoot) {
  if (sourceRoot === "agents") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200";
  }
  return sourceRoot === "claude"
    ? "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-200"
    : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200";
}

function bulkSkillGrantChangeLabel(change: BulkSkillGrantPreview["agents"][number]["change"]) {
  if (change === "add") return "Add";
  if (change === "remove") return "Remove";
  if (change === "replace") return "Replace";
  return "No change";
}

function buildBulkSkillDepartmentOptions(
  navigation: CompanyAgentNavigation | undefined,
): Array<{ key: AgentDepartmentKey; label: string }> {
  const departments = new Map<AgentDepartmentKey, string>();
  departments.set("executive", "Executive");
  for (const department of navigation?.departments ?? []) {
    if (department.key === "shared_service") continue;
    departments.set(department.key, department.name);
  }
  return Array.from(departments.entries()).map(([key, label]) => ({ key, label }));
}

type BulkGrantPreviewState = {
  requestKey: string;
  preview: BulkSkillGrantPreview;
};

function BulkGrantDialog({
  open,
  onOpenChange,
  skill,
  canManage,
  navigation,
  navigationLoading,
  targetKind,
  onTargetKindChange,
  departmentKey,
  onDepartmentKeyChange,
  projectId,
  onProjectIdChange,
  tier,
  onTierChange,
  mode,
  onModeChange,
  replaceConfirmed,
  onReplaceConfirmedChange,
  preview,
  previewPending,
  applyPending,
  onPreview,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: CompanySkillDetail | null | undefined;
  canManage: boolean;
  navigation: CompanyAgentNavigation | undefined;
  navigationLoading: boolean;
  targetKind: "department" | "project";
  onTargetKindChange: (value: "department" | "project") => void;
  departmentKey: AgentDepartmentKey;
  onDepartmentKeyChange: (value: AgentDepartmentKey) => void;
  projectId: string;
  onProjectIdChange: (value: string) => void;
  tier: BulkSkillGrantTier;
  onTierChange: (value: BulkSkillGrantTier) => void;
  mode: BulkSkillGrantMode;
  onModeChange: (value: BulkSkillGrantMode) => void;
  replaceConfirmed: boolean;
  onReplaceConfirmedChange: (value: boolean) => void;
  preview: BulkSkillGrantPreview | null;
  previewPending: boolean;
  applyPending: boolean;
  onPreview: () => void;
  onApply: () => void;
}) {
  const departmentOptions = useMemo(
    () => buildBulkSkillDepartmentOptions(navigation),
    [navigation],
  );
  const projectOptions = navigation?.projectPods ?? [];
  const currentMode = BULK_SKILL_GRANT_MODES.find((entry) => entry.value === mode) ?? BULK_SKILL_GRANT_MODES[0]!;
  const canPreview =
    canManage
    && Boolean(skill)
    && (targetKind === "department" || projectId.length > 0)
    && !previewPending
    && !applyPending;
  const canApply =
    canManage
    && (preview?.changedAgentCount ?? 0) > 0
    && !previewPending
    && !applyPending
    && (mode !== "replace" || replaceConfirmed);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Grant Skill to Group</DialogTitle>
          <DialogDescription>
            Apply explicit per-agent skill grants to the current matching agents only. Future hires will not inherit this change automatically.
          </DialogDescription>
        </DialogHeader>

        {!skill ? (
          <div className="rounded-md border border-border px-4 py-4 text-sm text-muted-foreground">
            Select an installed company skill first.
          </div>
        ) : (
          <div className="space-y-5">
            <div className="rounded-md border border-border px-4 py-3">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Skill</div>
              <div className="mt-2 text-sm font-medium text-foreground">{skill.name}</div>
              <p className="mt-1 text-sm text-muted-foreground">
                Library visibility does not grant runtime access. This action writes explicit `desiredSkills` updates to matched agents.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                <div>
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Target type</div>
                  <Tabs
                    value={targetKind}
                    onValueChange={(value) => onTargetKindChange(value as "department" | "project")}
                    className="mt-2"
                  >
                    <TabsList variant="line" className="w-full justify-start gap-1">
                      <TabsTrigger value="department">Department</TabsTrigger>
                      <TabsTrigger value="project">Project</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>

                {targetKind === "department" ? (
                  <label className="block">
                    <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Department</div>
                    <select
                      value={departmentKey}
                      onChange={(event) => onDepartmentKeyChange(event.target.value as AgentDepartmentKey)}
                      className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground shadow-none"
                    >
                      {departmentOptions.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="block">
                    <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Project pod</div>
                    <select
                      value={projectId}
                      onChange={(event) => onProjectIdChange(event.target.value)}
                      className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground shadow-none"
                      disabled={projectOptions.length === 0}
                    >
                      {projectOptions.length === 0 ? (
                        <option value="">No projects available</option>
                      ) : null}
                      {projectOptions.map((project) => (
                        <option key={project.projectId} value={project.projectId}>
                          {project.projectName}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div className="space-y-3">
                <label className="block">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Tier</div>
                  <select
                    value={tier}
                    onChange={(event) => onTierChange(event.target.value as BulkSkillGrantTier)}
                    className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground shadow-none"
                  >
                    {BULK_SKILL_GRANT_TIERS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Operation</div>
                  <select
                    value={mode}
                    onChange={(event) => onModeChange(event.target.value as BulkSkillGrantMode)}
                    className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground shadow-none"
                  >
                    {BULK_SKILL_GRANT_MODES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-sm text-muted-foreground">{currentMode.description}</p>
                </label>
              </div>
            </div>

            {mode === "replace" ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
                <div className="font-medium">Replace removes other non-required skills.</div>
                <p className="mt-1 text-muted-foreground">
                  Required Paperclip skills stay on. Every other granted skill on the matched agents will be replaced with only {skill.name}.
                </p>
                <label className="mt-3 flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-border"
                    checked={replaceConfirmed}
                    onChange={(event) => onReplaceConfirmedChange(event.target.checked)}
                  />
                  <span>I understand this replaces every non-required granted skill on the matched agents.</span>
                </label>
              </div>
            ) : null}

            <div className="rounded-md border border-border">
              <div className="border-b border-border px-4 py-3">
                <div className="text-sm font-medium">Preview</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Preview the exact agent set before applying. The batch will fail if the matching set changes before you apply it.
                </p>
              </div>

              {navigationLoading ? (
                <div className="px-4 py-5 text-sm text-muted-foreground">Loading current agent groups…</div>
              ) : previewPending ? (
                <div className="px-4 py-5 text-sm text-muted-foreground">Computing preview…</div>
              ) : !preview ? (
                <div className="px-4 py-5 text-sm text-muted-foreground">
                  Choose a target and click <span className="font-medium text-foreground">Preview changes</span>.
                </div>
              ) : (
                <div className="space-y-4 px-4 py-4">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <div className="rounded-md border border-border px-3 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Matched</div>
                      <div className="mt-2 text-xl font-semibold">{preview.matchedAgentCount}</div>
                    </div>
                    <div className="rounded-md border border-border px-3 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Changed</div>
                      <div className="mt-2 text-xl font-semibold">{preview.changedAgentCount}</div>
                    </div>
                    <div className="rounded-md border border-border px-3 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Add</div>
                      <div className="mt-2 text-xl font-semibold">{preview.addCount}</div>
                    </div>
                    <div className="rounded-md border border-border px-3 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Remove</div>
                      <div className="mt-2 text-xl font-semibold">{preview.removeCount}</div>
                    </div>
                    <div className="rounded-md border border-border px-3 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Unchanged</div>
                      <div className="mt-2 text-xl font-semibold">{preview.unchangedCount}</div>
                    </div>
                  </div>

                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
                    <div className="rounded-md border border-border">
                      <div className="border-b border-border px-3 py-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                        Matched agents
                      </div>
                      {preview.agents.length === 0 ? (
                        <div className="px-3 py-4 text-sm text-muted-foreground">
                          No current agents match this group.
                        </div>
                      ) : (
                        preview.agents.map((agent) => (
                          <div
                            key={agent.id}
                            className="flex items-start justify-between gap-3 border-b border-border px-3 py-3 text-sm last:border-b-0"
                          >
                            <div className="min-w-0">
                              <Link
                                to={`/agents/${agent.urlKey}/skills`}
                                className="font-medium text-foreground no-underline hover:underline"
                              >
                                {agent.name}
                              </Link>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {agent.title ?? agent.role}
                              </div>
                            </div>
                            <div className="shrink-0 text-xs text-muted-foreground">
                              {bulkSkillGrantChangeLabel(agent.change)}
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    <div className="space-y-3 rounded-md border border-border px-3 py-3">
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Target</div>
                        <div className="mt-1 text-sm text-foreground">{preview.target.label}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Tier</div>
                        <div className="mt-1 text-sm text-foreground">
                          {BULK_SKILL_GRANT_TIERS.find((option) => option.value === preview.tier)?.label ?? preview.tier}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Operation</div>
                        <div className="mt-1 text-sm text-foreground">
                          {BULK_SKILL_GRANT_MODES.find((option) => option.value === preview.mode)?.label ?? preview.mode}
                        </div>
                      </div>
                      {preview.skippedAgents.length > 0 ? (
                        <div>
                          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Skipped</div>
                          <div className="mt-2 space-y-2">
                            {preview.skippedAgents.map((agent) => (
                              <div key={agent.id} className="rounded-md border border-border px-3 py-2 text-sm">
                                <div className="font-medium text-foreground">{agent.name}</div>
                                <div className="mt-1 text-xs text-muted-foreground">{agent.reason}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={previewPending || applyPending}>
            Close
          </Button>
          <Button variant="outline" onClick={onPreview} disabled={!canPreview}>
            {previewPending ? "Previewing..." : "Preview changes"}
          </Button>
          <Button onClick={onApply} disabled={!canApply}>
            {applyPending
              ? "Applying..."
              : preview
                ? `Apply to ${preview.changedAgentCount} agent${preview.changedAgentCount === 1 ? "" : "s"}`
                : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatTrustLevel(trustLevel: GlobalSkillCatalogItem["trustLevel"]) {
  switch (trustLevel) {
    case "markdown_only":
      return "Markdown only";
    case "assets":
      return "Includes assets";
    case "scripts_executables":
      return "Includes scripts";
    default:
      return trustLevel;
  }
}

function fileIcon(kind: CompanySkillFileInventoryEntry["kind"]) {
  if (kind === "script" || kind === "reference") return FileCode2;
  return FileText;
}

function encodeSkillFilePath(filePath: string) {
  return filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function decodeSkillFilePath(filePath: string | undefined) {
  if (!filePath) return "SKILL.md";
  return filePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function parseSkillRoute(routePath: string | undefined) {
  const segments = (routePath ?? "").split("/").filter(Boolean);
  if (segments.length === 0) {
    return { skillId: null, filePath: "SKILL.md" };
  }

  const [rawSkillId, rawMode, ...rest] = segments;
  const skillId = rawSkillId ? decodeURIComponent(rawSkillId) : null;
  if (!skillId) {
    return { skillId: null, filePath: "SKILL.md" };
  }

  if (rawMode === "files") {
    return {
      skillId,
      filePath: decodeSkillFilePath(rest.join("/")),
    };
  }

  return { skillId, filePath: "SKILL.md" };
}

function skillRoute(skillId: string, filePath?: string | null) {
  return filePath ? `/skills/${skillId}/files/${encodeSkillFilePath(filePath)}` : `/skills/${skillId}`;
}

function parentDirectoryPaths(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }
  return parents;
}

function NewSkillForm({
  onCreate,
  isPending,
  onCancel,
}: {
  onCreate: (payload: CompanySkillCreateRequest) => void;
  isPending: boolean;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");

  return (
    <div className="border-b border-border px-4 py-4">
      <div className="space-y-3">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Skill name"
          className="h-9 rounded-none border-0 border-b border-border px-0 shadow-none focus-visible:ring-0"
        />
        <Input
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="optional-shortname"
          className="h-9 rounded-none border-0 border-b border-border px-0 shadow-none focus-visible:ring-0"
        />
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Short description"
          className="min-h-20 rounded-none border-0 border-b border-border px-0 shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onCreate({ name, slug: slug || null, description: description || null })}
            disabled={isPending || name.trim().length === 0}
          >
            {isPending ? "Creating..." : "Create skill"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function coverageStatusLabel(status: CompanySkillCoverageAudit["agents"][number]["status"]) {
  if (status === "repairable_gap") return "Repairable gap";
  if (status === "nonrepairable_gap") return "Needs review";
  if (status === "customized") return "Customized";
  return "Covered";
}

function coverageStatusClassName(status: CompanySkillCoverageAudit["agents"][number]["status"]) {
  if (status === "repairable_gap") {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200";
  }
  if (status === "nonrepairable_gap") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200";
  }
  if (status === "customized") {
    return "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-200";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200";
}

function reliabilityStatusLabel(status: CompanySkillReliabilityAudit["skills"][number]["status"]) {
  if (status === "repairable_gap") return "Repairable gap";
  if (status === "proposal_stale") return "Proposal stale";
  if (status === "needs_review") return "Needs review";
  return "Healthy";
}

function reliabilityStatusClassName(status: CompanySkillReliabilityAudit["skills"][number]["status"]) {
  if (status === "repairable_gap") {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200";
  }
  if (status === "proposal_stale") {
    return "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-200";
  }
  if (status === "needs_review") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200";
}

function hardeningStateLabel(state: CompanySkillHardeningState | null | undefined) {
  if (!state) return "No hardening work";
  return state.replaceAll("_", " ");
}

function SkillReliabilityAuditPanel({
  audit,
  loading,
  error,
  preview,
  previewPending,
  applyPending,
  onPreview,
  onApply,
}: {
  audit: CompanySkillReliabilityAudit | undefined;
  loading: boolean;
  error: Error | null;
  preview: CompanySkillReliabilityRepairPreview | null;
  previewPending: boolean;
  applyPending: boolean;
  onPreview: () => void;
  onApply: () => void;
}) {
  if (loading && !audit) {
    return (
      <div className="rounded-md border border-border px-5 py-4 text-sm text-muted-foreground">
        Auditing skill reliability...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 px-5 py-4 text-sm text-destructive">
        {error.message}
      </div>
    );
  }

  if (!audit) return null;

  const activePreview = preview ?? null;
  const skills = activePreview?.skills ?? audit.skills;
  const visibleSkills = skills.filter((skill) => skill.status !== "healthy");
  const changedSkillCount = activePreview?.changedSkillCount ?? 0;
  const canApply = Boolean(activePreview && changedSkillCount > 0 && !applyPending);

  return (
    <div className="rounded-md border border-border">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Skill Reliability</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Audit whether each skill is reachable, non-duplicative, and backed by the declared verification path.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={onPreview} disabled={previewPending || applyPending}>
              {previewPending ? (
                <>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Previewing...
                </>
              ) : (
                "Preview hardening"
              )}
            </Button>
            <Button onClick={onApply} disabled={!canApply}>
              {applyPending
                ? "Applying..."
                : activePreview
                  ? `Create or refresh ${changedSkillCount} issue${changedSkillCount === 1 ? "" : "s"}`
                  : "Apply hardening"}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-md border border-border px-3 py-3">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Audited</div>
            <div className="mt-2 text-xl font-semibold">{audit.auditedSkillCount}</div>
          </div>
          <div className="rounded-md border border-border px-3 py-3">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Healthy</div>
            <div className="mt-2 text-xl font-semibold">{audit.healthyCount}</div>
          </div>
          <div className="rounded-md border border-border px-3 py-3">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Repairable</div>
            <div className="mt-2 text-xl font-semibold">{audit.repairableGapCount}</div>
          </div>
          <div className="rounded-md border border-border px-3 py-3">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Needs review</div>
            <div className="mt-2 text-xl font-semibold">{audit.needsReviewCount}</div>
          </div>
          <div className="rounded-md border border-border px-3 py-3">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Proposal stale</div>
            <div className="mt-2 text-xl font-semibold">{audit.proposalStaleCount}</div>
          </div>
        </div>
      </div>

      <div className="grid gap-5 px-5 py-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)]">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Skill findings</div>
          <div className="mt-3 rounded-md border border-border">
            {visibleSkills.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                Every installed skill currently passes the structural reliability audit.
              </div>
            ) : (
              visibleSkills.map((skill) => (
                <div key={skill.skillId} className="border-b border-border px-3 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link to={`/skills/${skill.skillId}`} className="font-medium text-foreground no-underline hover:underline">
                        {skill.name}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {skill.key} · {hardeningStateLabel(skill.hardeningState)}
                      </p>
                    </div>
                    <span className={cn("rounded-full border px-2 py-0.5 text-[10px] uppercase", reliabilityStatusClassName(skill.status))}>
                      {reliabilityStatusLabel(skill.status)}
                    </span>
                  </div>
                  <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                    {skill.findings.slice(0, 3).map((finding) => (
                      <li key={`${skill.skillId}-${finding.code}`}>• {finding.message}</li>
                    ))}
                  </ul>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    {skill.linkedHardeningIssue ? (
                      <Link
                        to={`/issues/${skill.linkedHardeningIssue.identifier ?? skill.linkedHardeningIssue.id}`}
                        className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-foreground no-underline hover:bg-accent/30"
                      >
                        <Workflow className="h-3 w-3" />
                        Hardening issue {skill.linkedHardeningIssue.identifier ?? skill.linkedHardeningIssue.id.slice(0, 8)}
                      </Link>
                    ) : null}
                    {skill.linkedProposal ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-muted-foreground">
                        Proposal {skill.linkedProposal.status.replaceAll("_", " ")}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-md border border-border px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              Managed adapter policy
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Semantic promptfoo route/process coverage is required only when a skill is used by Paperclip-managed local adapters.
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
              {audit.managedAdapterTypes.map((adapterType) => (
                <span key={adapterType} className="rounded-full border border-border px-2 py-1">
                  {adapterType}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-border px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
              Repair preview
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Repair creates or refreshes tracked hardening issues. It does not edit skill files or auto-approve shared-skill changes.
            </p>
            {activePreview ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Preview fingerprint: <span className="font-mono">{activePreview.selectionFingerprint.slice(0, 12)}</span>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function SkillCoverageAuditPanel({
  audit,
  loading,
  error,
  preview,
  previewPending,
  applyPending,
  onPreview,
  onApply,
}: {
  audit: CompanySkillCoverageAudit | undefined;
  loading: boolean;
  error: Error | null;
  preview: CompanySkillCoverageRepairPreview | null;
  previewPending: boolean;
  applyPending: boolean;
  onPreview: () => void;
  onApply: () => void;
}) {
  if (loading && !audit) {
    return (
      <div className="rounded-md border border-border px-5 py-4 text-sm text-muted-foreground">
        Auditing active agent skill coverage...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 px-5 py-4 text-sm text-destructive">
        {error.message}
      </div>
    );
  }

  if (!audit) return null;

  const activePreview = preview ?? null;
  const agents = activePreview?.agents ?? audit.agents;
  const visibleAgents = agents.filter((agent) => agent.status !== "covered");
  const changedAgentCount = activePreview?.changedAgentCount ?? 0;
  const plannedImports = activePreview?.plannedImports ?? audit.plannedImports;
  const canApply = Boolean(activePreview && changedAgentCount > 0 && !applyPending);

  return (
    <div className="rounded-md border border-border">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Active Workforce Coverage</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Audit every non-terminated agent against the default Paperclip skill packs, preserve custom grants, and repair missing baseline assignments conservatively.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={onPreview} disabled={previewPending || applyPending}>
              {previewPending ? (
                <>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Previewing...
                </>
              ) : (
                "Preview repair"
              )}
            </Button>
            <Button onClick={onApply} disabled={!canApply}>
              {applyPending
                ? "Applying..."
                : activePreview
                  ? `Apply to ${changedAgentCount} agent${changedAgentCount === 1 ? "" : "s"}`
                  : "Apply repair"}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-md border border-border px-3 py-3">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Audited</div>
            <div className="mt-2 text-xl font-semibold">{audit.auditedAgentCount}</div>
          </div>
          <div className="rounded-md border border-border px-3 py-3">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Covered</div>
            <div className="mt-2 text-xl font-semibold">{audit.coveredCount}</div>
          </div>
          <div className="rounded-md border border-border px-3 py-3">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Repairable</div>
            <div className="mt-2 text-xl font-semibold">{audit.repairableGapCount}</div>
          </div>
          <div className="rounded-md border border-border px-3 py-3">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Customized</div>
            <div className="mt-2 text-xl font-semibold">{audit.customizedCount}</div>
          </div>
          <div className="rounded-md border border-border px-3 py-3">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Needs review</div>
            <div className="mt-2 text-xl font-semibold">{audit.nonrepairableGapCount}</div>
          </div>
        </div>
      </div>

      <div className="grid gap-5 px-5 py-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Agent coverage</div>
          <div className="mt-3 rounded-md border border-border">
            {visibleAgents.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                Every active agent already matches its expected baseline pack.
              </div>
            ) : (
              visibleAgents.map((agent) => (
                <div key={agent.id} className="border-b border-border px-3 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        to={`/agents/${agent.urlKey}/skills`}
                        className="font-medium text-foreground no-underline hover:underline"
                      >
                        {agent.name}
                      </Link>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {agent.title ?? agent.role}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                        coverageStatusClassName(agent.status),
                      )}
                    >
                      {coverageStatusLabel(agent.status)}
                    </span>
                  </div>
                  {agent.note ? (
                    <p className="mt-3 text-sm text-muted-foreground">{agent.note}</p>
                  ) : null}
                  {agent.missingSkillSlugs.length > 0 ? (
                    <div className="mt-3 text-xs text-muted-foreground">
                      Missing defaults: {agent.missingSkillSlugs.join(", ")}
                    </div>
                  ) : null}
                  {agent.preservedCustomSkillKeys.length > 0 ? (
                    <div className="mt-2 text-xs text-muted-foreground">
                      Preserved custom grants: {agent.preservedCustomSkillKeys.join(", ")}
                    </div>
                  ) : null}
                  {agent.repairable && !sameStringArray(agent.currentDesiredSkills, agent.nextDesiredSkills) ? (
                    <div className="mt-2 text-xs text-muted-foreground">
                      Next explicit grants: {agent.nextDesiredSkills.join(", ")}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Planned imports</div>
            <div className="mt-3 rounded-md border border-border">
              {plannedImports.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  No additional library imports are required for the current baseline packs.
                </div>
              ) : (
                plannedImports.map((entry) => (
                  <div key={entry.expectedKey} className="border-b border-border px-3 py-3 last:border-b-0">
                    <div className="text-sm font-medium text-foreground">{entry.name}</div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{entry.expectedKey}</div>
                    <div className="mt-2 text-xs text-muted-foreground break-all">{entry.sourcePath}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-md border border-border px-3 py-3 text-sm text-muted-foreground">
            {activePreview
              ? changedAgentCount === 0
                ? "The preview found no repairable assignment changes to apply."
                : `${changedAgentCount} active agent${changedAgentCount === 1 ? "" : "s"} will receive repaired explicit skill grants.`
              : "Run Preview repair to freeze the exact import set and per-agent assignment changes before applying."}
          </div>
        </div>
      </div>
    </div>
  );
}

function SkillTree({
  nodes,
  skillId,
  selectedPath,
  expandedDirs,
  onToggleDir,
  onSelectPath,
  depth = 0,
}: {
  nodes: SkillTreeNode[];
  skillId: string;
  selectedPath: string;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectPath: (path: string) => void;
  depth?: number;
}) {
  return (
    <div>
      {nodes.map((node) => {
        const expanded = node.kind === "dir" && node.path ? expandedDirs.has(node.path) : false;
        if (node.kind === "dir") {
          return (
            <div key={node.path ?? node.name}>
              <div
                className={cn(
                  "group grid w-full grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                  SKILL_TREE_ROW_HEIGHT_CLASS,
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 py-1 text-left"
                  style={{ paddingLeft: `${SKILL_TREE_BASE_INDENT + depth * SKILL_TREE_STEP_INDENT}px` }}
                  onClick={() => node.path && onToggleDir(node.path)}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {expanded ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
                  </span>
                  <span className="truncate">{node.name}</span>
                </button>
                <button
                  type="button"
                  className="flex h-9 w-9 items-center justify-center self-center rounded-sm text-muted-foreground opacity-70 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground group-hover:opacity-100"
                  onClick={() => node.path && onToggleDir(node.path)}
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              </div>
              {expanded && (
                <SkillTree
                  nodes={node.children}
                  skillId={skillId}
                  selectedPath={selectedPath}
                  expandedDirs={expandedDirs}
                  onToggleDir={onToggleDir}
                  onSelectPath={onSelectPath}
                  depth={depth + 1}
                />
              )}
            </div>
          );
        }

        const FileIcon = fileIcon(node.fileKind ?? "other");
        return (
          <Link
            key={node.path ?? node.name}
            className={cn(
              "flex w-full items-center gap-2 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground",
              SKILL_TREE_ROW_HEIGHT_CLASS,
              node.path === selectedPath && "text-foreground",
            )}
            style={{ paddingInlineStart: `${SKILL_TREE_BASE_INDENT + depth * SKILL_TREE_STEP_INDENT}px` }}
            to={skillRoute(skillId, node.path)}
            onClick={() => node.path && onSelectPath(node.path)}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <FileIcon className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">{node.name}</span>
          </Link>
        );
      })}
    </div>
  );
}

function SkillList({
  skills,
  selectedSkillId,
  skillFilter,
  expandedSkillId,
  expandedDirs,
  selectedPaths,
  onToggleSkill,
  onToggleDir,
  onSelectSkill,
  onSelectPath,
}: {
  skills: CompanySkillListItem[];
  selectedSkillId: string | null;
  skillFilter: string;
  expandedSkillId: string | null;
  expandedDirs: Record<string, Set<string>>;
  selectedPaths: Record<string, string>;
  onToggleSkill: (skillId: string) => void;
  onToggleDir: (skillId: string, path: string) => void;
  onSelectSkill: (skillId: string) => void;
  onSelectPath: (skillId: string, path: string) => void;
}) {
  const filteredSkills = skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.key} ${skill.slug} ${skill.sourceLabel ?? ""}`.toLowerCase();
    return haystack.includes(skillFilter.toLowerCase());
  });

  if (filteredSkills.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        No skills match this filter.
      </div>
    );
  }

  return (
    <div>
      {filteredSkills.map((skill) => {
        const expanded = expandedSkillId === skill.id;
        const tree = buildTree(skill.fileInventory);
        const source = sourceMeta(skill.sourceBadge, skill.sourceLabel);
        const SourceIcon = source.icon;

        return (
          <div key={skill.id} className="border-b border-border">
            <div
              className={cn(
                "group grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-1 px-3 py-1.5 hover:bg-accent/30",
                skill.id === selectedSkillId && "text-foreground",
              )}
            >
              <Link
                to={skillRoute(skill.id)}
                className="flex min-w-0 items-center self-stretch pr-2 text-left no-underline"
                onClick={() => onSelectSkill(skill.id)}
              >
                <span className="flex min-w-0 items-center gap-2 self-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground opacity-75 transition-opacity group-hover:opacity-100">
                        <SourceIcon className="h-3.5 w-3.5" />
                        <span className="sr-only">{source.managedLabel}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">{source.managedLabel}</TooltipContent>
                  </Tooltip>
                  <span className="min-w-0 overflow-hidden text-[13px] font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                    {skill.name}
                  </span>
                </span>
              </Link>
              <button
                type="button"
                className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-sm text-muted-foreground opacity-80 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground group-hover:opacity-100"
                onClick={() => onToggleSkill(skill.id)}
                aria-label={expanded ? `Collapse ${skill.name}` : `Expand ${skill.name}`}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            </div>
            <div
              aria-hidden={!expanded}
              className={cn(
                "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
                expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <SkillTree
                  nodes={tree}
                  skillId={skill.id}
                  selectedPath={selectedPaths[skill.id] ?? "SKILL.md"}
                  expandedDirs={expandedDirs[skill.id] ?? new Set<string>()}
                  onToggleDir={(path) => onToggleDir(skill.id, path)}
                  onSelectPath={(path) => onSelectPath(skill.id, path)}
                  depth={1}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GlobalCatalogList({
  items,
  selectedCatalogKey,
  skillFilter,
  installPendingCatalogKey,
  installDisabled,
  onSelect,
  onInstall,
}: {
  items: GlobalSkillCatalogItem[];
  selectedCatalogKey: string | null;
  skillFilter: string;
  installPendingCatalogKey: string | null;
  installDisabled: boolean;
  onSelect: (catalogKey: string) => void;
  onInstall: (catalogKey: string) => void;
}) {
  const filteredItems = items.filter((item) => {
    const haystack = `${item.name} ${item.slug} ${item.description ?? ""} ${item.sourcePath}`.toLowerCase();
    return haystack.includes(skillFilter.toLowerCase());
  });

  if (filteredItems.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        No global skills match this filter.
      </div>
    );
  }

  return (
    <div>
      {filteredItems.map((item) => {
        const selected = item.catalogKey === selectedCatalogKey;
        const isInstalling = installPendingCatalogKey === item.catalogKey;
        const installed = Boolean(item.installedSkillId);

        return (
          <div key={item.catalogKey} className="border-b border-border">
            <div
              className={cn(
                "group flex items-start justify-between gap-3 px-3 py-3 hover:bg-accent/30",
                selected && "bg-accent/20 text-foreground",
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onSelect(item.catalogKey)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-medium leading-5">{item.name}</span>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                      globalCatalogSourceClassName(item.sourceRoot),
                    )}
                  >
                    {globalCatalogSourceLabel(item.sourceRoot)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {installed ? "Installed" : "Not installed"}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {item.description ?? item.sourcePath}
                </div>
              </button>
              <Button
                variant={installed ? "outline" : "ghost"}
                size="sm"
                className="shrink-0"
                disabled={installDisabled}
                onClick={() => onInstall(item.catalogKey)}
              >
                {isInstalling ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : installed ? (
                  "Reinstall"
                ) : (
                  "Install"
                )}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GlobalCatalogPane({
  loading,
  error,
  item,
  installPending,
  installDisabled,
  onInstall,
}: {
  loading: boolean;
  error: Error | null;
  item: GlobalSkillCatalogItem | null;
  installPending: boolean;
  installDisabled: boolean;
  onInstall: () => void;
}) {
  if (loading) {
    return <PageSkeleton variant="detail" />;
  }

  if (error) {
    return (
      <div className="px-5 py-6 text-sm text-destructive">
        {error.message}
      </div>
    );
  }

  if (!item) {
    return (
      <EmptyState
        icon={Boxes}
        message="Select a global skill to inspect its install status."
      />
    );
  }

  const installed = Boolean(item.installedSkillId);

  return (
    <div className="min-w-0">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold">{item.name}</h1>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em]",
                  globalCatalogSourceClassName(item.sourceRoot),
                )}
              >
                {globalCatalogSourceLabel(item.sourceRoot)}
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              {item.description ?? "Install a read-only snapshot into this company before assigning it to agents."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {item.installedSkillId ? (
              <Link
                to={`/skills/${item.installedSkillId}`}
                className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground no-underline transition-colors hover:bg-accent/40"
              >
                Open installed copy
              </Link>
            ) : null}
            <Button onClick={onInstall} disabled={installDisabled}>
              {installPending ? (
                <>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Installing...
                </>
              ) : installed ? (
                "Reinstall snapshot"
              ) : (
                "Install to company"
              )}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
            <span className="text-muted-foreground">Install status</span>
            <span>{installed ? "Installed" : "Not installed"}</span>
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
            <span className="text-muted-foreground">Trust level</span>
            <span>{formatTrustLevel(item.trustLevel)}</span>
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
            <span className="text-muted-foreground">Compatibility</span>
            <span>{item.compatibility}</span>
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
            <span className="text-muted-foreground">Files</span>
            <span>{item.fileInventory.length}</span>
          </div>
        </div>
      </div>

      <div className="grid gap-6 px-5 py-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="space-y-3">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Source folder</div>
            <div className="mt-2 rounded-md border border-border bg-muted/20 px-3 py-3 font-mono text-xs text-foreground break-all">
              {item.sourcePath}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">What gets installed</div>
            <p className="mt-2 text-sm text-muted-foreground">
              Paperclip copies this skill into the company library as a read-only snapshot. Agents can only use the installed company copy, not the home-directory source directly.
            </p>
          </div>
        </div>

        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">File inventory</div>
          <div className="mt-2 rounded-md border border-border">
            {item.fileInventory.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">No files detected.</div>
            ) : (
              item.fileInventory.map((entry) => (
                <div
                  key={entry.path}
                  className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0"
                >
                  <span className="truncate font-mono text-xs">{entry.path}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{entry.kind}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SkillPane({
  selectionKey,
  loading,
  detail,
  file,
  fileLoading,
  updateStatus,
  updateStatusLoading,
  onCheckUpdates,
  checkUpdatesPending,
  onInstallUpdate,
  installUpdatePending,
  onDelete,
  deletePending,
  onOpenBulkGrant,
  canManageBulkGrant,
  onSave,
  savePending,
}: {
  selectionKey: string;
  loading: boolean;
  detail: CompanySkillDetail | null | undefined;
  file: CompanySkillFileDetail | null | undefined;
  fileLoading: boolean;
  updateStatus: CompanySkillUpdateStatus | null | undefined;
  updateStatusLoading: boolean;
  onCheckUpdates: () => void;
  checkUpdatesPending: boolean;
  onInstallUpdate: () => void;
  installUpdatePending: boolean;
  onDelete: () => void;
  deletePending: boolean;
  onOpenBulkGrant: () => void;
  canManageBulkGrant: boolean;
  onSave: (draft: string) => void;
  savePending: boolean;
}) {
  const { pushToast } = useToast();
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!file) {
      setDraft("");
      return;
    }
    setDraft(file.markdown ? splitFrontmatter(file.content).body : file.content);
  }, [file, selectionKey]);

  if (!detail) {
    if (loading) {
      return <PageSkeleton variant="detail" />;
    }
    return (
      <EmptyState
        icon={Boxes}
        message="Select a skill to inspect its files."
      />
    );
  }

  const source = sourceMeta(detail.sourceBadge, detail.sourceLabel);
  const SourceIcon = source.icon;
  const usedBy = detail.usedByAgents;
  const body = file?.markdown ? stripFrontmatter(file.content) : file?.content ?? "";
  const currentPin = shortRef(detail.sourceRef);
  const latestPin = shortRef(updateStatus?.latestRef);
  const removeBlocked = usedBy.length > 0;
  const removeDisabledReason = removeBlocked
    ? "Detach this skill from all agents before removing it."
    : null;
  const reliabilityWarnings = detail.reliabilityParseWarnings ?? [];
  const reliabilityMetadata = detail.reliabilityMetadata ?? null;

  return (
    <div className="min-w-0">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-2xl font-semibold">
              <SourceIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
              {detail.name}
            </h1>
            {detail.description && (
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{detail.description}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canManageBulkGrant ? (
              <Button variant="outline" size="sm" onClick={onOpenBulkGrant}>
                Grant to group
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={deletePending}
              title={removeDisabledReason ?? undefined}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {deletePending ? "Removing..." : "Remove"}
            </Button>
            {detail.editable ? (
              <button
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setEditMode(!editMode)}
              >
                <Pencil className="h-3.5 w-3.5" />
                {editMode ? "Stop editing" : "Edit"}
              </button>
            ) : (
              <div className="text-sm text-muted-foreground">{detail.editableReason}</div>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Source</span>
              <span className="flex items-center gap-2">
                <SourceIcon className="h-3.5 w-3.5 text-muted-foreground" />
                {detail.sourcePath ? (
                  <button
                    className="truncate hover:text-foreground text-muted-foreground transition-colors cursor-pointer"
                    onClick={() => {
                      navigator.clipboard.writeText(detail.sourcePath!);
                      pushToast({ title: "Copied path to workspace" });
                    }}
                  >
                    {source.label}
                  </button>
                ) : (
                  <span className="truncate">{source.label}</span>
                )}
              </span>
            </div>
            {detail.sourceType === "github" && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Pin</span>
                <span className="font-mono text-xs">{currentPin ?? "untracked"}</span>
                {updateStatus?.trackingRef && (
                  <span className="text-xs text-muted-foreground">tracking {updateStatus.trackingRef}</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCheckUpdates}
                  disabled={checkUpdatesPending || updateStatusLoading}
                >
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (checkUpdatesPending || updateStatusLoading) && "animate-spin")} />
                  Check for updates
                </Button>
                {updateStatus?.supported && updateStatus.hasUpdate && (
                  <Button
                    size="sm"
                    onClick={onInstallUpdate}
                    disabled={installUpdatePending}
                  >
                    <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", installUpdatePending && "animate-spin")} />
                    Install update{latestPin ? ` ${latestPin}` : ""}
                  </Button>
                )}
                {updateStatus?.supported && !updateStatus.hasUpdate && !updateStatusLoading && (
                  <span className="text-xs text-muted-foreground">Up to date</span>
                )}
                {!updateStatus?.supported && updateStatus?.reason && (
                  <span className="text-xs text-muted-foreground">{updateStatus.reason}</span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Key</span>
              <span className="font-mono text-xs">{detail.key}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Mode</span>
              <span>{detail.editable ? "Editable" : "Read only"}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Used by</span>
            {usedBy.length === 0 ? (
              <span className="text-muted-foreground">No agents attached</span>
            ) : (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {usedBy.map((agent) => (
                  <Link
                    key={agent.id}
                    to={`/agents/${agent.urlKey}/skills`}
                    className="text-foreground no-underline hover:underline"
                  >
                    {agent.name}
                  </Link>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Reliability</span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className={cn("rounded-full border px-2 py-0.5 text-[10px] uppercase", detail.hardeningState ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200" : "border-border bg-background/80 text-muted-foreground")}>
                {hardeningStateLabel(detail.hardeningState)}
              </span>
              {detail.linkedHardeningIssue ? (
                <Link
                  to={`/issues/${detail.linkedHardeningIssue.identifier ?? detail.linkedHardeningIssue.id}`}
                  className="inline-flex items-center gap-1 text-foreground no-underline hover:underline"
                >
                  Hardening issue {detail.linkedHardeningIssue.identifier ?? detail.linkedHardeningIssue.id.slice(0, 8)}
                </Link>
              ) : null}
              {detail.linkedProposal ? (
                <Link
                  to={`/instance/settings/shared-skills/${detail.linkedProposal.id}`}
                  className="inline-flex items-center gap-1 text-foreground no-underline hover:underline"
                >
                  Proposal {detail.linkedProposal.status.replaceAll("_", " ")}
                </Link>
              ) : null}
            </div>
          </div>
          {reliabilityWarnings.length > 0 ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-amber-700 dark:text-amber-200">
              <div className="font-medium">Reliability metadata warnings</div>
              <ul className="mt-2 space-y-1">
                {reliabilityWarnings.map((warning) => (
                  <li key={warning}>• {warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {reliabilityMetadata ? (
            <div className="grid gap-3 rounded-md border border-border px-3 py-3 md:grid-cols-2">
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Activation hints</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {reliabilityMetadata.activationHints.length > 0 ? reliabilityMetadata.activationHints.map((hint) => (
                    <span key={hint} className="rounded-full border border-border px-2 py-1 text-xs">{hint}</span>
                  )) : <span className="text-sm text-muted-foreground">None declared</span>}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Deterministic entrypoints</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {reliabilityMetadata.deterministicEntrypoints.length > 0 ? reliabilityMetadata.deterministicEntrypoints.map((entrypoint) => (
                    <span key={entrypoint} className="rounded-full border border-border px-2 py-1 font-mono text-xs">{entrypoint}</span>
                  )) : <span className="text-sm text-muted-foreground">None declared</span>}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Verification</div>
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                  <li>Unit commands: {reliabilityMetadata.verification?.unitCommands.length ?? 0}</li>
                  <li>Integration commands: {reliabilityMetadata.verification?.integrationCommands.length ?? 0}</li>
                  <li>Promptfoo cases: {reliabilityMetadata.verification?.promptfooCaseIds.length ?? 0}</li>
                  <li>Architecture scenarios: {reliabilityMetadata.verification?.architectureScenarioIds.length ?? 0}</li>
                  <li>Smoke checklist: {reliabilityMetadata.verification?.smokeChecklist.length ?? 0}</li>
                </ul>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Overlap & disambiguation</div>
                <div className="mt-2 space-y-2 text-sm text-muted-foreground">
                  <div>
                    Overlap domains: {reliabilityMetadata.overlapDomains.length > 0 ? reliabilityMetadata.overlapDomains.join(", ") : "none"}
                  </div>
                  <div>
                    Disambiguation hints: {reliabilityMetadata.disambiguationHints.length > 0 ? reliabilityMetadata.disambiguationHints.join(", ") : "none"}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm">{file?.path ?? "SKILL.md"}</div>
          </div>
          <div className="flex items-center gap-2">
            {file?.markdown && !editMode && (
              <div className="flex items-center border border-border">
                <button
                  className={cn("px-3 py-1.5 text-sm", viewMode === "preview" && "text-foreground", viewMode !== "preview" && "text-muted-foreground")}
                  onClick={() => setViewMode("preview")}
                >
                  <span className="flex items-center gap-1.5">
                    <Eye className="h-3.5 w-3.5" />
                    View
                  </span>
                </button>
                <button
                  className={cn("border-l border-border px-3 py-1.5 text-sm", viewMode === "code" && "text-foreground", viewMode !== "code" && "text-muted-foreground")}
                  onClick={() => setViewMode("code")}
                >
                  <span className="flex items-center gap-1.5">
                    <Code2 className="h-3.5 w-3.5" />
                    Code
                  </span>
                </button>
              </div>
            )}
            {editMode && file?.editable && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditMode(false)} disabled={savePending}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => onSave(draft)} disabled={savePending}>
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {savePending ? "Saving..." : "Save"}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-[560px] px-5 py-5">
        {fileLoading ? (
          <PageSkeleton variant="detail" />
        ) : !file ? (
          <div className="text-sm text-muted-foreground">Select a file to inspect.</div>
        ) : editMode && file.editable ? (
          file.markdown ? (
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              bordered={false}
              className="min-h-[520px]"
            />
          ) : (
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[520px] rounded-none border-0 bg-transparent px-0 py-0 font-mono text-sm shadow-none focus-visible:ring-0"
            />
          )
        ) : file.markdown && viewMode === "preview" ? (
          <MarkdownBody softBreaks={false} linkIssueReferences={false}>{body}</MarkdownBody>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word border-0 bg-transparent p-0 font-mono text-sm text-foreground">
            <code>{file.content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

export function CompanySkills() {
  const { "*": routePath } = useParams<{ "*": string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [libraryView, setLibraryView] = useState<"installed" | "global">("installed");
  const [skillFilter, setSkillFilter] = useState("");
  const [source, setSource] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [emptySourceHelpOpen, setEmptySourceHelpOpen] = useState(false);
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, Set<string>>>({});
  const [displayedDetail, setDisplayedDetail] = useState<CompanySkillDetail | null>(null);
  const [displayedFile, setDisplayedFile] = useState<CompanySkillFileDetail | null>(null);
  const [scanStatusMessage, setScanStatusMessage] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTargetSkillId, setDeleteTargetSkillId] = useState<string | null>(null);
  const [deleteTargetDetail, setDeleteTargetDetail] = useState<CompanySkillDetail | null>(null);
  const [selectedCatalogKey, setSelectedCatalogKey] = useState<string | null>(null);
  const [bulkGrantOpen, setBulkGrantOpen] = useState(false);
  const [bulkGrantTargetKind, setBulkGrantTargetKind] = useState<"department" | "project">("department");
  const [bulkGrantDepartmentKey, setBulkGrantDepartmentKey] = useState<AgentDepartmentKey>("executive");
  const [bulkGrantProjectId, setBulkGrantProjectId] = useState("");
  const [bulkGrantTier, setBulkGrantTier] = useState<BulkSkillGrantTier>("all");
  const [bulkGrantMode, setBulkGrantMode] = useState<BulkSkillGrantMode>("add");
  const [bulkGrantPreviewState, setBulkGrantPreviewState] = useState<BulkGrantPreviewState | null>(null);
  const [bulkGrantReplaceConfirmed, setBulkGrantReplaceConfirmed] = useState(false);
  const parsedRoute = useMemo(() => parseSkillRoute(routePath), [routePath]);
  const routeSkillId = parsedRoute.skillId;
  const selectedPath = parsedRoute.filePath;
  const hasDesktopBridge = Boolean(getPaperclipDesktopBridge());

  useEffect(() => {
    setBreadcrumbs([
      { label: "Skills", href: "/skills" },
      ...(routeSkillId ? [{ label: "Detail" }] : []),
    ]);
  }, [routeSkillId, setBreadcrumbs]);

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const globalCatalogQuery = useQuery({
    queryKey: queryKeys.companySkills.globalCatalog(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.globalCatalog(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && libraryView === "global"),
  });

  const coverageAuditQuery = useQuery({
    queryKey: queryKeys.companySkills.coverageAudit(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.coverageAudit(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && libraryView === "installed"),
    staleTime: 60_000,
  });

  const reliabilityAuditQuery = useQuery({
    queryKey: queryKeys.companySkills.reliabilityAudit(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.reliabilityAudit(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && libraryView === "installed"),
    staleTime: 60_000,
  });

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    staleTime: 60_000,
  });

  const bulkGrantNavigationQuery = useQuery({
    queryKey: queryKeys.agents.navigation(selectedCompanyId ?? "", "department"),
    queryFn: () => agentsApi.navigation(selectedCompanyId!, "department"),
    enabled: Boolean(selectedCompanyId && bulkGrantOpen && libraryView === "installed"),
    staleTime: 60_000,
  });

  const selectedSkillId = useMemo(() => {
    if (!routeSkillId) return skillsQuery.data?.[0]?.id ?? null;
    return routeSkillId;
  }, [routeSkillId, skillsQuery.data]);

  const filteredGlobalCatalog = useMemo(() => {
    const items = globalCatalogQuery.data ?? [];
    return items.filter((item) => {
      const haystack = `${item.name} ${item.slug} ${item.description ?? ""} ${item.sourcePath}`.toLowerCase();
      return haystack.includes(skillFilter.toLowerCase());
    });
  }, [globalCatalogQuery.data, skillFilter]);

  const selectedCatalogItem = useMemo(() => {
    if (filteredGlobalCatalog.length === 0) return null;
    return filteredGlobalCatalog.find((item) => item.catalogKey === selectedCatalogKey) ?? filteredGlobalCatalog[0] ?? null;
  }, [filteredGlobalCatalog, selectedCatalogKey]);
  const hasUninstalledGlobalSkills = useMemo(
    () => (globalCatalogQuery.data ?? []).some((item) => !item.installedSkillId),
    [globalCatalogQuery.data],
  );

  const departmentTargetOptions = useMemo(
    () => buildBulkSkillDepartmentOptions(bulkGrantNavigationQuery.data),
    [bulkGrantNavigationQuery.data],
  );
  const projectTargetOptions = useMemo(
    () => bulkGrantNavigationQuery.data?.projectPods ?? [],
    [bulkGrantNavigationQuery.data],
  );
  const canManageBulkGrants = Boolean(sessionQuery.data?.session?.userId) || hasDesktopBridge;
  const bulkGrantRequest = useMemo<BulkSkillGrantRequest | null>(() => {
    if (!selectedCompanyId || !selectedSkillId) return null;
    if (bulkGrantTargetKind === "project") {
      if (!bulkGrantProjectId) return null;
      return {
        target: { kind: "project", projectId: bulkGrantProjectId },
        tier: bulkGrantTier,
        mode: bulkGrantMode,
      };
    }
    return {
      target: { kind: "department", departmentKey: bulkGrantDepartmentKey },
      tier: bulkGrantTier,
      mode: bulkGrantMode,
    };
  }, [
    bulkGrantDepartmentKey,
    bulkGrantMode,
    bulkGrantProjectId,
    bulkGrantTargetKind,
    bulkGrantTier,
    selectedCompanyId,
    selectedSkillId,
  ]);
  const bulkGrantRequestKey = useMemo(() => {
    if (!bulkGrantOpen || !selectedSkillId || !bulkGrantRequest) return null;
    return JSON.stringify({
      skillId: selectedSkillId,
      request: bulkGrantRequest,
    });
  }, [bulkGrantOpen, bulkGrantRequest, selectedSkillId]);
  const bulkGrantPreview =
    bulkGrantPreviewState && bulkGrantPreviewState.requestKey === bulkGrantRequestKey
      ? bulkGrantPreviewState.preview
      : null;

  useEffect(() => {
    if (libraryView !== "installed" || routeSkillId || !selectedSkillId) return;
    navigate(skillRoute(selectedSkillId), { replace: true });
  }, [libraryView, navigate, routeSkillId, selectedSkillId]);

  const detailQuery = useQuery({
    queryKey: queryKeys.companySkills.detail(selectedCompanyId ?? "", selectedSkillId ?? ""),
    queryFn: () => companySkillsApi.detail(selectedCompanyId!, selectedSkillId!),
    enabled: Boolean(selectedCompanyId && selectedSkillId && libraryView === "installed"),
  });

  const fileQuery = useQuery({
    queryKey: queryKeys.companySkills.file(selectedCompanyId ?? "", selectedSkillId ?? "", selectedPath),
    queryFn: () => companySkillsApi.file(selectedCompanyId!, selectedSkillId!, selectedPath),
    enabled: Boolean(selectedCompanyId && selectedSkillId && selectedPath && libraryView === "installed"),
  });

  const updateStatusQuery = useQuery({
    queryKey: queryKeys.companySkills.updateStatus(selectedCompanyId ?? "", selectedSkillId ?? ""),
    queryFn: () => companySkillsApi.updateStatus(selectedCompanyId!, selectedSkillId!),
    enabled: Boolean(
      selectedCompanyId
      && selectedSkillId
      && libraryView === "installed"
      && (detailQuery.data?.sourceType === "github" || displayedDetail?.sourceType === "github"),
    ),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (libraryView === "installed") {
      setExpandedSkillId(selectedSkillId);
    }
  }, [libraryView, selectedSkillId]);

  useEffect(() => {
    if (libraryView !== "global") return;
    if (filteredGlobalCatalog.length === 0) {
      setSelectedCatalogKey(null);
      return;
    }
    if (selectedCatalogKey && filteredGlobalCatalog.some((item) => item.catalogKey === selectedCatalogKey)) {
      return;
    }
    setSelectedCatalogKey(filteredGlobalCatalog[0]!.catalogKey);
  }, [filteredGlobalCatalog, libraryView, selectedCatalogKey]);

  useEffect(() => {
    if (!bulkGrantOpen) return;
    if (departmentTargetOptions.length === 0) return;
    if (departmentTargetOptions.some((option) => option.key === bulkGrantDepartmentKey)) return;
    setBulkGrantDepartmentKey(departmentTargetOptions[0]!.key);
  }, [bulkGrantDepartmentKey, bulkGrantOpen, departmentTargetOptions]);

  useEffect(() => {
    if (!bulkGrantOpen || bulkGrantTargetKind !== "project") return;
    if (projectTargetOptions.length === 0) {
      if (bulkGrantProjectId !== "") setBulkGrantProjectId("");
      return;
    }
    if (projectTargetOptions.some((project) => project.projectId === bulkGrantProjectId)) return;
    setBulkGrantProjectId(projectTargetOptions[0]!.projectId);
  }, [bulkGrantOpen, bulkGrantProjectId, bulkGrantTargetKind, projectTargetOptions]);

  useEffect(() => {
    if (bulkGrantMode === "replace") return;
    if (bulkGrantReplaceConfirmed) {
      setBulkGrantReplaceConfirmed(false);
    }
  }, [bulkGrantMode, bulkGrantReplaceConfirmed]);

  useEffect(() => {
    if (!selectedSkillId || selectedPath === "SKILL.md") return;
    const parents = parentDirectoryPaths(selectedPath);
    if (parents.length === 0) return;
    setExpandedDirs((current) => {
      const next = new Set(current[selectedSkillId] ?? []);
      let changed = false;
      for (const parent of parents) {
        if (!next.has(parent)) {
          next.add(parent);
          changed = true;
        }
      }
      return changed ? { ...current, [selectedSkillId]: next } : current;
    });
  }, [selectedPath, selectedSkillId]);

  useEffect(() => {
    if (detailQuery.data) {
      setDisplayedDetail(detailQuery.data);
    }
  }, [detailQuery.data]);

  useEffect(() => {
    if (fileQuery.data) {
      setDisplayedFile(fileQuery.data);
    }
  }, [fileQuery.data]);

  useEffect(() => {
    if (selectedSkillId) return;
    setDisplayedDetail(null);
    setDisplayedFile(null);
  }, [selectedSkillId]);

  const activeDetail = detailQuery.data ?? displayedDetail;
  const activeFile = fileQuery.data ?? displayedFile;
  const skillPaneSelectionKey = `${selectedSkillId ?? "none"}:${selectedPath}:${libraryView}`;

  function openDeleteDialog() {
    setDeleteTargetSkillId(selectedSkillId);
    setDeleteTargetDetail(activeDetail ?? null);
    setDeleteOpen(true);
  }

  function closeDeleteDialog(open: boolean) {
    setDeleteOpen(open);
    if (!open) {
      setDeleteTargetSkillId(null);
      setDeleteTargetDetail(null);
    }
  }

  const importSkill = useMutation({
    mutationFn: (importSource: string) => companySkillsApi.importFromSource(selectedCompanyId!, importSource),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.coverageAudit(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.reliabilityAudit(selectedCompanyId!) }),
      ]);
      if (result.imported[0]) navigate(skillRoute(result.imported[0].id));
      pushToast({
        tone: "success",
        title: "Skills imported",
        body: `${result.imported.length} skill${result.imported.length === 1 ? "" : "s"} added.`,
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: "Import warnings", body: result.warnings[0] });
      }
      setSource("");
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Skill import failed",
        body: error instanceof Error ? error.message : "Failed to import skill source.",
      });
    },
  });

  const installGlobalSkill = useMutation({
    mutationFn: (catalogKey: string) => companySkillsApi.installGlobal(selectedCompanyId!, { catalogKey }),
    onSuccess: async (skill) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.globalCatalog(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.coverageAudit(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.reliabilityAudit(selectedCompanyId!) }),
      ]);
      pushToast({
        tone: "success",
        title: "Skill installed",
        body: `${skill.name} is now available in the company library.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Global skill install failed",
        body: error instanceof Error ? error.message : "Failed to install global skill.",
      });
    },
  });

  const installAllGlobalSkills = useMutation({
    mutationFn: () => companySkillsApi.installAllGlobal(selectedCompanyId!),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.globalCatalog(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.coverageAudit(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.reliabilityAudit(selectedCompanyId!) }),
      ]);
      const summaryParts = [
        `${result.installedCount} installed`,
        `${result.alreadyInstalledCount} already installed`,
      ];
      if (result.skipped.length > 0) {
        summaryParts.push(`${result.skipped.length} skipped`);
      }
      pushToast({
        tone: "success",
        title: "Global skills installed",
        body: `${summaryParts.join(", ")}.`,
      });
      if (result.skipped[0]) {
        pushToast({
          tone: "warn",
          title: "Some global skills were skipped",
          body: result.skipped[0].reason,
        });
      }
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Install all failed",
        body: error instanceof Error ? error.message : "Failed to install global skills.",
      });
    },
  });
  const globalSkillInstallBusy = installGlobalSkill.isPending || installAllGlobalSkills.isPending;

  const previewCoverageRepair = useMutation({
    mutationFn: () => companySkillsApi.coverageRepairPreview(selectedCompanyId!),
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Coverage preview failed",
        body: error instanceof Error ? error.message : "Failed to preview workforce skill repair.",
      });
    },
  });

  const applyCoverageRepair = useMutation({
    mutationFn: (selectionFingerprint: string) =>
      companySkillsApi.coverageRepairApply(selectedCompanyId!, { selectionFingerprint }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.coverageAudit(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.navigation(selectedCompanyId!, "department") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.navigation(selectedCompanyId!, "project") }),
      ]);
      for (const agentId of result.appliedAgentIds) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.skills(agentId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      }
      previewCoverageRepair.reset();
      pushToast({
        tone: "success",
        title: "Coverage repair applied",
        body:
          result.changedAgentCount === 0
            ? "No active agent grants needed to change."
            : `${result.changedAgentCount} active agent${result.changedAgentCount === 1 ? "" : "s"} updated.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Coverage repair failed",
        body: error instanceof Error ? error.message : "Failed to apply workforce skill repair.",
      });
    },
  });

  const previewReliabilityRepair = useMutation({
    mutationFn: () => companySkillsApi.reliabilityRepairPreview(selectedCompanyId!),
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Reliability preview failed",
        body: error instanceof Error ? error.message : "Failed to preview skill hardening work.",
      });
    },
  });

  const applyReliabilityRepair = useMutation({
    mutationFn: (selectionFingerprint: string) =>
      companySkillsApi.reliabilityRepairApply(selectedCompanyId!, { selectionFingerprint }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.reliabilityAudit(selectedCompanyId!) }),
      ]);
      previewReliabilityRepair.reset();
      pushToast({
        tone: "success",
        title: "Skill hardening issues refreshed",
        body:
          result.changedSkillCount === 0
            ? "No skill hardening issues needed to change."
            : `${result.changedSkillCount} skill${result.changedSkillCount === 1 ? "" : "s"} now have refreshed hardening work.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Reliability repair failed",
        body: error instanceof Error ? error.message : "Failed to refresh skill hardening issues.",
      });
    },
  });

  const previewBulkGrant = useMutation({
    mutationFn: ({ payload }: { payload: BulkSkillGrantRequest; requestKey: string }) =>
      companySkillsApi.bulkGrantPreview(selectedCompanyId!, selectedSkillId!, payload),
    onSuccess: (preview, variables) => {
      setBulkGrantPreviewState({
        requestKey: variables.requestKey,
        preview,
      });
    },
    onError: (error) => {
      setBulkGrantPreviewState(null);
      pushToast({
        tone: "error",
        title: "Bulk grant preview failed",
        body: error instanceof Error ? error.message : "Failed to preview bulk skill changes.",
      });
    },
  });

  const applyBulkGrant = useMutation({
    mutationFn: (payload: BulkSkillGrantRequest & { selectionFingerprint: string }) =>
      companySkillsApi.bulkGrantApply(selectedCompanyId!, selectedSkillId!, payload),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.reliabilityAudit(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.navigation(selectedCompanyId!, "department") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.navigation(selectedCompanyId!, "project") }),
      ]);
      for (const agentId of result.appliedAgentIds) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.skills(agentId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      }
      setBulkGrantOpen(false);
      setBulkGrantPreviewState(null);
      setBulkGrantReplaceConfirmed(false);
      pushToast({
        tone: "success",
        title: "Bulk skill grant applied",
        body:
          result.changedAgentCount === 0
            ? "No matching agent grants needed to change."
            : `${result.changedAgentCount} agent${result.changedAgentCount === 1 ? "" : "s"} updated for ${result.skillName}.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Bulk skill grant failed",
        body: error instanceof Error ? error.message : "Failed to apply bulk skill grant.",
      });
    },
  });

  const createSkill = useMutation({
    mutationFn: (payload: CompanySkillCreateRequest) => companySkillsApi.create(selectedCompanyId!, payload),
    onSuccess: async (skill) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.coverageAudit(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.reliabilityAudit(selectedCompanyId!) }),
      ]);
      navigate(skillRoute(skill.id));
      setCreateOpen(false);
      pushToast({
        tone: "success",
        title: "Skill created",
        body: `${skill.name} is now editable in the Paperclip workspace.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Skill creation failed",
        body: error instanceof Error ? error.message : "Failed to create skill.",
      });
    },
  });

  const scanProjects = useMutation({
    mutationFn: () => companySkillsApi.scanProjects(selectedCompanyId!),
    onMutate: () => {
      setScanStatusMessage("Scanning project workspaces for skills...");
    },
    onSuccess: async (result) => {
      setScanStatusMessage("Refreshing skills list...");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.coverageAudit(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.reliabilityAudit(selectedCompanyId!) }),
      ]);
      const summary = formatProjectScanSummary(result);
      setScanStatusMessage(summary);
      pushToast({
        tone: "success",
        title: "Project skill scan complete",
        body: summary,
      });
      if (result.conflicts[0]) {
        pushToast({
          tone: "warn",
          title: "Skill conflicts found",
          body: result.conflicts[0].reason,
        });
      } else if (result.warnings[0]) {
        pushToast({
          tone: "warn",
          title: "Scan warnings",
          body: result.warnings[0],
        });
      }
    },
    onError: (error) => {
      setScanStatusMessage(null);
      pushToast({
        tone: "error",
        title: "Project skill scan failed",
        body: error instanceof Error ? error.message : "Failed to scan project workspaces.",
      });
    },
  });

  const saveFile = useMutation({
    mutationFn: (nextDraft: string) => companySkillsApi.updateFile(
      selectedCompanyId!,
      selectedSkillId!,
      selectedPath,
      activeFile?.markdown ? mergeFrontmatter(activeFile.content, nextDraft) : nextDraft,
    ),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.file(selectedCompanyId!, selectedSkillId!, selectedPath) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.reliabilityAudit(selectedCompanyId!) }),
      ]);
      pushToast({
        tone: "success",
        title: "Skill saved",
        body: result.path,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Save failed",
        body: error instanceof Error ? error.message : "Failed to save skill file.",
      });
    },
  });

  const installUpdate = useMutation({
    mutationFn: () => companySkillsApi.installUpdate(selectedCompanyId!, selectedSkillId!),
    onSuccess: async (skill) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.updateStatus(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.file(selectedCompanyId!, selectedSkillId!, selectedPath) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.coverageAudit(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.reliabilityAudit(selectedCompanyId!) }),
      ]);
      navigate(skillRoute(skill.id, selectedPath));
      pushToast({
        tone: "success",
        title: "Skill updated",
        body: skill.sourceRef ? `Pinned to ${shortRef(skill.sourceRef)}` : skill.name,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Update failed",
        body: error instanceof Error ? error.message : "Failed to install skill update.",
      });
    },
  });

  const deleteSkill = useMutation({
    mutationFn: () => companySkillsApi.delete(selectedCompanyId!, deleteTargetSkillId!),
    onSuccess: async (skill) => {
      closeDeleteDialog(false);
      setDisplayedDetail(null);
      setDisplayedFile(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.coverageAudit(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.reliabilityAudit(selectedCompanyId!) }),
        ...(deleteTargetSkillId ? [
          queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, deleteTargetSkillId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.updateStatus(selectedCompanyId!, deleteTargetSkillId) }),
        ] : []),
        ...(deleteTargetSkillId ? [
          queryClient.invalidateQueries({
            queryKey: queryKeys.companySkills.file(selectedCompanyId!, deleteTargetSkillId, selectedPath),
          }),
        ] : []),
      ]);
      await queryClient.refetchQueries({
        queryKey: queryKeys.companySkills.list(selectedCompanyId!),
        type: "active",
      });
      navigate("/skills", { replace: true });
      pushToast({
        tone: "success",
        title: "Skill removed",
        body: `${skill.name} was removed from the company skill library.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Remove failed",
        body: error instanceof Error ? error.message : "Failed to remove skill.",
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Boxes} message="Select a company to manage skills." />;
  }

  function handleAddSkillSource() {
    const trimmedSource = source.trim();
    if (trimmedSource.length === 0) {
      setEmptySourceHelpOpen(true);
      return;
    }
    importSkill.mutate(trimmedSource);
  }

  function openBulkGrantDialog() {
    setBulkGrantPreviewState(null);
    setBulkGrantOpen(true);
  }

  function closeBulkGrantDialog(open: boolean) {
    setBulkGrantOpen(open);
    if (!open) {
      setBulkGrantPreviewState(null);
      setBulkGrantReplaceConfirmed(false);
    }
  }

  return (
    <>
      <BulkGrantDialog
        open={bulkGrantOpen}
        onOpenChange={closeBulkGrantDialog}
        skill={activeDetail}
        canManage={canManageBulkGrants}
        navigation={bulkGrantNavigationQuery.data}
        navigationLoading={bulkGrantNavigationQuery.isLoading}
        targetKind={bulkGrantTargetKind}
        onTargetKindChange={setBulkGrantTargetKind}
        departmentKey={bulkGrantDepartmentKey}
        onDepartmentKeyChange={setBulkGrantDepartmentKey}
        projectId={bulkGrantProjectId}
        onProjectIdChange={setBulkGrantProjectId}
        tier={bulkGrantTier}
        onTierChange={setBulkGrantTier}
        mode={bulkGrantMode}
        onModeChange={setBulkGrantMode}
        replaceConfirmed={bulkGrantReplaceConfirmed}
        onReplaceConfirmedChange={setBulkGrantReplaceConfirmed}
        preview={bulkGrantPreview}
        previewPending={previewBulkGrant.isPending}
        applyPending={applyBulkGrant.isPending}
        onPreview={() => {
          if (!bulkGrantRequest || !bulkGrantRequestKey) return;
          previewBulkGrant.mutate({
            payload: bulkGrantRequest,
            requestKey: bulkGrantRequestKey,
          });
        }}
        onApply={() => {
          if (!bulkGrantRequest || !bulkGrantPreview) return;
          applyBulkGrant.mutate({
            ...bulkGrantRequest,
            selectionFingerprint: bulkGrantPreview.selectionFingerprint,
          });
        }}
      />

      <Dialog open={deleteOpen} onOpenChange={closeDeleteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove skill</DialogTitle>
            <DialogDescription>
              Remove this skill from the company library. If any agents still use it, removal will be blocked until it is detached.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {deleteTargetDetail
                ? `You are about to remove ${deleteTargetDetail.name}.`
                : "You are about to remove this skill."}
            </p>
            {deleteTargetDetail?.usedByAgents?.length ? (
              <div className="rounded-md border border-border px-3 py-3 text-muted-foreground">
                Currently used by {deleteTargetDetail.usedByAgents.map((agent) => agent.name).join(", ")}.
              </div>
            ) : null}
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <p className="text-muted-foreground">
                Detach this skill from all agents to enable removal.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <Button variant="ghost" onClick={() => closeDeleteDialog(false)}>
                Close
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => closeDeleteDialog(false)} disabled={deleteSkill.isPending}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => deleteSkill.mutate()}
                  disabled={deleteSkill.isPending || !deleteTargetSkillId}
                >
                  {deleteSkill.isPending ? "Removing..." : "Remove skill"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={emptySourceHelpOpen} onOpenChange={setEmptySourceHelpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a skill source</DialogTitle>
            <DialogDescription>
              Paste a local path, GitHub URL, or `skills.sh` command into the field first.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              className="flex items-start justify-between rounded-md border border-border px-3 py-3 text-foreground no-underline transition-colors hover:bg-accent/40"
            >
              <span>
                <span className="block font-medium">Browse skills.sh</span>
                <span className="mt-1 block text-muted-foreground">
                  Find install commands and paste one here.
                </span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
            <a
              href="https://github.com/search?q=SKILL.md&type=code"
              target="_blank"
              rel="noreferrer"
              className="flex items-start justify-between rounded-md border border-border px-3 py-3 text-foreground no-underline transition-colors hover:bg-accent/40"
            >
              <span>
                <span className="block font-medium">Search GitHub</span>
                <span className="mt-1 block text-muted-foreground">
                  Look for repositories with `SKILL.md`, then paste the repo URL here.
                </span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
          </div>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <div className="grid min-h-[calc(100vh-12rem)] gap-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
        <aside className="border-r border-border">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h1 className="text-base font-semibold">Skills</h1>
                <p className="text-xs text-muted-foreground">
                  {libraryView === "installed"
                    ? `${skillsQuery.data?.length ?? 0} available`
                    : formatGlobalCatalogCount(globalCatalogQuery.data?.length ?? 0)}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {libraryView === "installed" ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => scanProjects.mutate()}
                      disabled={scanProjects.isPending}
                      title="Scan project workspaces for skills"
                    >
                      <RefreshCw className={cn("h-4 w-4", scanProjects.isPending && "animate-spin")} />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => setCreateOpen((value) => !value)}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => installAllGlobalSkills.mutate()}
                      disabled={!hasUninstalledGlobalSkills || globalSkillInstallBusy}
                      title="Install every discoverable global skill into this company"
                    >
                      {installAllGlobalSkills.isPending ? (
                        <>
                          <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          Installing...
                        </>
                      ) : (
                        "Install all"
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void globalCatalogQuery.refetch()}
                      disabled={globalCatalogQuery.isFetching || globalSkillInstallBusy}
                      title="Refresh global catalog"
                    >
                      <RefreshCw className={cn("h-4 w-4", globalCatalogQuery.isFetching && "animate-spin")} />
                    </Button>
                  </>
                )}
              </div>
            </div>

            <Tabs
              value={libraryView}
              onValueChange={(value) => setLibraryView(value as "installed" | "global")}
              className="mt-3"
            >
              <TabsList variant="line" className="w-full justify-start gap-1">
                <TabsTrigger value="installed">Installed</TabsTrigger>
                <TabsTrigger value="global">Global Catalog</TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <Input
                value={skillFilter}
                onChange={(event) => setSkillFilter(event.target.value)}
                placeholder={libraryView === "installed" ? "Filter skills" : "Filter global skills"}
                className="h-8 border-0 px-0 text-sm shadow-none focus-visible:ring-0"
              />
            </div>

            {libraryView === "installed" ? (
              <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
                <Input
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder="Paste path, GitHub URL, or skills.sh command"
                  className="h-8 border-0 px-0 text-sm shadow-none focus-visible:ring-0"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleAddSkillSource}
                  disabled={importSkill.isPending}
                >
                  {importSkill.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : "Add"}
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                Install a read-only snapshot into this company before assigning a skill to agents.
              </p>
            )}
            {libraryView === "installed" && scanStatusMessage && (
              <p className="mt-3 text-xs text-muted-foreground">
                {scanStatusMessage}
              </p>
            )}
          </div>

          {libraryView === "installed" && createOpen && (
            <NewSkillForm
              onCreate={(payload) => createSkill.mutate(payload)}
              isPending={createSkill.isPending}
              onCancel={() => setCreateOpen(false)}
            />
          )}

          {libraryView === "installed" ? (
            skillsQuery.isLoading ? (
              <PageSkeleton variant="list" />
            ) : skillsQuery.error ? (
              <div className="px-4 py-6 text-sm text-destructive">{skillsQuery.error.message}</div>
            ) : (
              <SkillList
                skills={skillsQuery.data ?? []}
                selectedSkillId={selectedSkillId}
                skillFilter={skillFilter}
                expandedSkillId={expandedSkillId}
                expandedDirs={expandedDirs}
                selectedPaths={selectedSkillId ? { [selectedSkillId]: selectedPath } : {}}
                onToggleSkill={(currentSkillId) =>
                  setExpandedSkillId((current) => current === currentSkillId ? null : currentSkillId)
                }
                onToggleDir={(currentSkillId, path) => {
                  setExpandedDirs((current) => {
                    const next = new Set(current[currentSkillId] ?? []);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return { ...current, [currentSkillId]: next };
                  });
                }}
                onSelectSkill={(currentSkillId) => setExpandedSkillId(currentSkillId)}
                onSelectPath={() => {}}
              />
            )
          ) : (
            <GlobalCatalogList
              items={globalCatalogQuery.data ?? []}
              selectedCatalogKey={selectedCatalogItem?.catalogKey ?? null}
              skillFilter={skillFilter}
              installPendingCatalogKey={installGlobalSkill.isPending ? installGlobalSkill.variables ?? null : null}
              installDisabled={globalSkillInstallBusy}
              onSelect={setSelectedCatalogKey}
              onInstall={(catalogKey) => installGlobalSkill.mutate(catalogKey)}
            />
          )}
        </aside>

        <div className="min-w-0 pl-6">
          {libraryView === "installed" ? (
            <div className="space-y-6 py-4 pr-6">
              <SkillCoverageAuditPanel
                audit={coverageAuditQuery.data}
                loading={coverageAuditQuery.isLoading}
                error={coverageAuditQuery.error instanceof Error ? coverageAuditQuery.error : null}
                preview={previewCoverageRepair.data ?? null}
                previewPending={previewCoverageRepair.isPending}
                applyPending={applyCoverageRepair.isPending}
                onPreview={() => previewCoverageRepair.mutate()}
                onApply={() => {
                  const fingerprint = previewCoverageRepair.data?.selectionFingerprint;
                  if (!fingerprint) return;
                  applyCoverageRepair.mutate(fingerprint);
                }}
              />

              <SkillReliabilityAuditPanel
                audit={reliabilityAuditQuery.data}
                loading={reliabilityAuditQuery.isLoading}
                error={reliabilityAuditQuery.error instanceof Error ? reliabilityAuditQuery.error : null}
                preview={previewReliabilityRepair.data ?? null}
                previewPending={previewReliabilityRepair.isPending}
                applyPending={applyReliabilityRepair.isPending}
                onPreview={() => previewReliabilityRepair.mutate()}
                onApply={() => {
                  const fingerprint = previewReliabilityRepair.data?.selectionFingerprint;
                  if (!fingerprint) return;
                  applyReliabilityRepair.mutate(fingerprint);
                }}
              />

              <SkillPane
                key={skillPaneSelectionKey}
                selectionKey={skillPaneSelectionKey}
                loading={skillsQuery.isLoading || detailQuery.isLoading}
                detail={activeDetail}
                file={activeFile}
                fileLoading={fileQuery.isLoading && !activeFile}
                updateStatus={updateStatusQuery.data}
                updateStatusLoading={updateStatusQuery.isLoading}
                onCheckUpdates={() => {
                  void updateStatusQuery.refetch();
                }}
                checkUpdatesPending={updateStatusQuery.isFetching}
                onInstallUpdate={() => installUpdate.mutate()}
                installUpdatePending={installUpdate.isPending}
                onDelete={openDeleteDialog}
                deletePending={deleteSkill.isPending}
                onOpenBulkGrant={openBulkGrantDialog}
                canManageBulkGrant={canManageBulkGrants}
                onSave={(nextDraft) => saveFile.mutate(nextDraft)}
                savePending={saveFile.isPending}
              />
            </div>
          ) : (
            <GlobalCatalogPane
              loading={globalCatalogQuery.isLoading}
              error={globalCatalogQuery.error instanceof Error ? globalCatalogQuery.error : null}
              item={selectedCatalogItem}
              installPending={
                installGlobalSkill.isPending
                && installGlobalSkill.variables === selectedCatalogItem?.catalogKey
              }
              installDisabled={globalSkillInstallBusy}
              onInstall={() => {
                if (selectedCatalogItem) {
                  installGlobalSkill.mutate(selectedCatalogItem.catalogKey);
                }
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}
