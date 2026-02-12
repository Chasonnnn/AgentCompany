import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FolderKanban, Home, Plus, Search, Settings } from "lucide-react";
import { Button } from "@/components/primitives/Button";
import { Badge } from "@/components/primitives/Badge";
import type { ProjectSummary } from "@/types";

type Props = {
  projects: ProjectSummary[];
  selectedScope: { kind: "workspace" | "project"; projectId?: string };
  onSelectWorkspace: () => void;
  onSelectProject: (projectId: string) => void;
  onCreateProject: () => void;
  onOpenSettings: () => void;
  onQuickSwitch: () => void;
};

function shortLabel(name: string): string {
  const clean = name.trim();
  if (!clean) return "P";
  const chunks = clean.split(/\s+/).filter(Boolean);
  if (chunks.length > 1) {
    return `${chunks[0][0] ?? ""}${chunks[1][0] ?? ""}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

export function ProjectRail({
  projects,
  selectedScope,
  onSelectWorkspace,
  onSelectProject,
  onCreateProject,
  onOpenSettings,
  onQuickSwitch
}: Props) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: projects.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 62,
    overscan: 6
  });

  return (
    <aside className="pane" style={{ display: "grid", gridTemplateRows: "auto 1fr auto", padding: 8, gap: 8 }}>
      <div className="stack" style={{ alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            border: "1px solid var(--border-strong)",
            display: "grid",
            placeItems: "center",
            background: "var(--surface-elevated)",
            fontSize: 12,
            fontWeight: 700
          }}
        >
          AC
        </div>
        <Button
          tone={selectedScope.kind === "workspace" ? "primary" : "default"}
          iconOnly
          onClick={onSelectWorkspace}
          title="Workspace Home"
        >
          <Home size={16} />
        </Button>
      </div>

      <div ref={parentRef} style={{ minHeight: 0, overflow: "auto" }}>
        <div style={{ position: "relative", height: `${virtualizer.getTotalSize()}px`, width: "100%" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const project = projects[item.index];
            const active = selectedScope.kind === "project" && selectedScope.projectId === project.project_id;
            const badge = project.pending_reviews > 0 ? project.pending_reviews : project.active_runs;
            return (
              <div
                key={project.project_id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                  padding: "4px 0"
                }}
              >
                <button
                  type="button"
                  className={`list-row ${active ? "active" : ""}`}
                  style={{
                    flexDirection: "column",
                    minHeight: 54,
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                    padding: "8px 4px"
                  }}
                  onClick={() => onSelectProject(project.project_id)}
                  title={project.name}
                >
                  <span style={{ fontSize: 11, fontWeight: 700 }}>{shortLabel(project.name)}</span>
                  {badge > 0 ? <Badge>{badge}</Badge> : <span className="muted" style={{ fontSize: 10 }}>•</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="stack" style={{ alignItems: "center", gap: 8 }}>
        <Button iconOnly onClick={onQuickSwitch} title="Quick Switch (Cmd/Ctrl+K)">
          <Search size={15} />
        </Button>
        <Button iconOnly onClick={onCreateProject} title="Add Project">
          <Plus size={16} />
        </Button>
        <Button iconOnly onClick={onOpenSettings} title="Settings">
          <Settings size={16} />
        </Button>
        <Button iconOnly title="Projects">
          <FolderKanban size={16} />
        </Button>
      </div>
    </aside>
  );
}
