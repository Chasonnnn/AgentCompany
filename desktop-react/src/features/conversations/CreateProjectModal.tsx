import { useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Modal } from "@/components/primitives/Modal";
import { parseRepoIds } from "@/services/rpc";

type Props = {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (args: { name: string; repoIds: string[] }) => Promise<void>;
};

export function CreateProjectModal({ open, pending, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [repos, setRepos] = useState("");

  return (
    <Modal
      title="Create Project"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            disabled={pending || !name.trim()}
            onClick={async () => {
              await onSubmit({ name: name.trim(), repoIds: parseRepoIds(repos) });
              setName("");
              setRepos("");
            }}
          >
            {pending ? "Creating..." : "Create"}
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Project name</label>
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project Atlas" />
      </div>
      <div className="field">
        <label>Repo IDs (comma separated)</label>
        <Input value={repos} onChange={(event) => setRepos(event.target.value)} placeholder="repo_main,repo_docs" />
      </div>
    </Modal>
  );
}

