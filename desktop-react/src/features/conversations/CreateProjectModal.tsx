import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Modal } from "@/components/primitives/Modal";

type Props = {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (args: { repoPath: string }) => Promise<void>;
  onPickRepoFolder: () => Promise<string | null>;
};

export function CreateProjectModal({ open, pending, onClose, onSubmit, onPickRepoFolder }: Props) {
  const [repoPath, setRepoPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setRepoPath("");
      setError("");
      setPicking(false);
    }
  }, [open]);

  async function browse() {
    setPicking(true);
    setError("");
    try {
      const picked = await onPickRepoFolder();
      if (picked) setRepoPath(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  }

  async function submit() {
    setError("");
    try {
      await onSubmit({ repoPath: repoPath.trim() });
      setRepoPath("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      title="Add Repo Folder"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" disabled={pending || !repoPath.trim()} onClick={() => void submit()}>
            {pending ? "Adding..." : "Add"}
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Repository folder</label>
        <div className="hstack">
          <Input
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            placeholder="/Users/chason/path/to/repo"
          />
          <Button onClick={() => void browse()} disabled={pending || picking}>
            {picking ? "Opening..." : "Browse"}
          </Button>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Project name and repo ID are created automatically from the selected folder.
      </div>
      {error ? <div className="error">{error}</div> : null}
    </Modal>
  );
}
