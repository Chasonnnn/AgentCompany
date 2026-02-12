import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Modal } from "@/components/primitives/Modal";

type Props = {
  open: boolean;
  workspaceDir: string;
  projectId?: string;
  actorId: string;
  onClose: () => void;
};

function resolveInvoke():
  | ((command: string, args?: Record<string, unknown>) => Promise<unknown>)
  | null {
  const v1 = (window as any).__TAURI__?.core?.invoke;
  if (typeof v1 === "function") return v1;
  const v2 = (window as any).__TAURI_INTERNALS__?.invoke;
  if (typeof v2 === "function") return (command: string, args?: Record<string, unknown>) => v2(command, args ?? {});
  return null;
}

export function LiveOpsModal({ open, workspaceDir, projectId, actorId, onClose }: Props) {
  const [url, setUrl] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    if (!projectId) {
      setUrl("");
      setError("Live Ops requires a project context.");
      return;
    }
    const invoke = resolveInvoke();
    if (!invoke) {
      setError("Tauri runtime unavailable.");
      return;
    }
    void invoke("start_manager_web", {
      args: {
        workspaceDir,
        projectId,
        actorId,
        actorRole: "ceo",
        syncIndex: true
      }
    })
      .then((result: any) => {
        setError("");
        setUrl(String(result?.url ?? ""));
      })
      .catch((err) => {
        setUrl("");
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [open, workspaceDir, projectId, actorId]);

  return (
    <Modal
      title="Live Ops"
      open={open}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error ? (
        <div className="empty-state">
          <div className="error">{error}</div>
        </div>
      ) : url ? (
        <iframe
          title="Live Ops"
          src={url}
          style={{ width: "100%", minHeight: 500, border: "1px solid var(--border-subtle)", borderRadius: 10 }}
        />
      ) : (
        <div className="empty-state">Starting live operations surface...</div>
      )}
    </Modal>
  );
}

