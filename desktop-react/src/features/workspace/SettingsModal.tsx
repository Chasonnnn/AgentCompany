import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Modal } from "@/components/primitives/Modal";

type Props = {
  open: boolean;
  workspaceDir: string;
  actorId: string;
  reduceTransparency: boolean;
  onClose: () => void;
  onSave: (args: { workspaceDir: string; actorId: string; reduceTransparency: boolean }) => void;
};

export function SettingsModal({
  open,
  workspaceDir,
  actorId,
  reduceTransparency,
  onClose,
  onSave
}: Props) {
  const [draftWorkspace, setDraftWorkspace] = useState(workspaceDir);
  const [draftActor, setDraftActor] = useState(actorId);
  const [draftReduce, setDraftReduce] = useState(reduceTransparency);

  useEffect(() => {
    if (!open) return;
    setDraftWorkspace(workspaceDir);
    setDraftActor(actorId);
    setDraftReduce(reduceTransparency);
  }, [open, workspaceDir, actorId, reduceTransparency]);

  return (
    <Modal
      title="Desktop Settings"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            onClick={() =>
              onSave({
                workspaceDir: draftWorkspace.trim(),
                actorId: draftActor.trim() || "human_ceo",
                reduceTransparency: draftReduce
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Workspace directory</label>
        <Input
          value={draftWorkspace}
          onChange={(event) => setDraftWorkspace(event.target.value)}
          placeholder="/Users/chason/AgentCompany/work"
        />
      </div>
      <div className="field">
        <label>CEO actor ID</label>
        <Input value={draftActor} onChange={(event) => setDraftActor(event.target.value)} placeholder="human_ceo" />
      </div>
      <label className="hstack">
        <input type="checkbox" checked={draftReduce} onChange={(event) => setDraftReduce(event.target.checked)} />
        <span>Reduce transparency (compatibility mode)</span>
      </label>
    </Modal>
  );
}

