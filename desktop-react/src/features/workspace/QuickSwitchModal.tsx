import { useMemo, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Modal } from "@/components/primitives/Modal";
import type { ProjectSummary } from "@/types";

type Props = {
  open: boolean;
  projects: ProjectSummary[];
  onClose: () => void;
  onSelectWorkspace: () => void;
  onSelectProject: (projectId: string) => void;
};

export function QuickSwitchModal({ open, projects, onClose, onSelectWorkspace, onSelectProject }: Props) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((project) => project.name.toLowerCase().includes(q));
  }, [projects, query]);

  return (
    <Modal
      title="Quick Switch"
      open={open}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="field">
        <label>Search</label>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Project name" />
      </div>
      <div className="stack">
        <button
          type="button"
          className="list-row"
          onClick={() => {
            onSelectWorkspace();
            onClose();
          }}
        >
          <span>Workspace Home</span>
        </button>
        {rows.map((project) => (
          <button
            key={project.project_id}
            type="button"
            className="list-row"
            onClick={() => {
              onSelectProject(project.project_id);
              onClose();
            }}
          >
            <span>{project.name}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              {Math.round(project.progress_pct)}%
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

