import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Modal } from "@/components/primitives/Modal";
import { deleteGeminiApiKey, getGeminiApiKeyStatus, setGeminiApiKey } from "@/services/rpc";

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
  const [draftGeminiApiKey, setDraftGeminiApiKey] = useState("");
  const [geminiApiKeyConfigured, setGeminiApiKeyConfigured] = useState(false);
  const [geminiApiKeyStorage, setGeminiApiKeyStorage] = useState<"macos_keychain" | "unsupported">(
    "macos_keychain"
  );
  const [geminiApiKeyBusy, setGeminiApiKeyBusy] = useState(false);
  const [geminiApiKeyError, setGeminiApiKeyError] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraftWorkspace(workspaceDir);
    setDraftActor(actorId);
    setDraftReduce(reduceTransparency);
    setDraftGeminiApiKey("");
    setGeminiApiKeyError("");
    let canceled = false;
    void (async () => {
      setGeminiApiKeyBusy(true);
      try {
        const status = await getGeminiApiKeyStatus();
        if (canceled) return;
        setGeminiApiKeyConfigured(status.configured);
        setGeminiApiKeyStorage(status.storage);
      } catch (error) {
        if (canceled) return;
        setGeminiApiKeyError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!canceled) setGeminiApiKeyBusy(false);
      }
    })();
    return () => {
      canceled = true;
    };
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
          placeholder="/path/to/AgentCompany/work"
        />
      </div>
      <div className="field">
        <label>CEO actor ID</label>
        <Input value={draftActor} onChange={(event) => setDraftActor(event.target.value)} placeholder="human_ceo" />
      </div>
      <div className="field">
        <label>Gemini API Key (Executive Manager)</label>
        <Input
          type="password"
          value={draftGeminiApiKey}
          onChange={(event) => setDraftGeminiApiKey(event.target.value)}
          placeholder="AIza..."
        />
        <div className="muted" style={{ marginTop: 6 }}>
          {geminiApiKeyConfigured
            ? `Configured (${geminiApiKeyStorage === "macos_keychain" ? "macOS Keychain" : "Unsupported storage"})`
            : "Not configured"}
        </div>
        {geminiApiKeyError ? (
          <div className="muted" style={{ marginTop: 6, color: "var(--danger-500)" }}>
            {geminiApiKeyError}
          </div>
        ) : null}
        <div className="hstack" style={{ marginTop: 10 }}>
          <Button
            tone="primary"
            disabled={geminiApiKeyBusy || !draftGeminiApiKey.trim()}
            onClick={() => {
              const value = draftGeminiApiKey.trim();
              if (!value) return;
              void (async () => {
                setGeminiApiKeyBusy(true);
                setGeminiApiKeyError("");
                try {
                  const status = await setGeminiApiKey(value);
                  setGeminiApiKeyConfigured(status.configured);
                  setGeminiApiKeyStorage(status.storage);
                  setDraftGeminiApiKey("");
                } catch (error) {
                  setGeminiApiKeyError(error instanceof Error ? error.message : String(error));
                } finally {
                  setGeminiApiKeyBusy(false);
                }
              })();
            }}
          >
            {geminiApiKeyBusy ? "Saving..." : "Save Gemini Key"}
          </Button>
          <Button
            disabled={geminiApiKeyBusy || !geminiApiKeyConfigured}
            onClick={() => {
              void (async () => {
                setGeminiApiKeyBusy(true);
                setGeminiApiKeyError("");
                try {
                  const status = await deleteGeminiApiKey();
                  setGeminiApiKeyConfigured(status.configured);
                  setGeminiApiKeyStorage(status.storage);
                } catch (error) {
                  setGeminiApiKeyError(error instanceof Error ? error.message : String(error));
                } finally {
                  setGeminiApiKeyBusy(false);
                }
              })();
            }}
          >
            Remove Gemini Key
          </Button>
        </div>
      </div>
      <label className="hstack">
        <input type="checkbox" checked={draftReduce} onChange={(event) => setDraftReduce(event.target.checked)} />
        <span>Reduce transparency (compatibility mode)</span>
      </label>
    </Modal>
  );
}
