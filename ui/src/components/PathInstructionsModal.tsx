import { useState } from "react";
import { Apple, Monitor, Terminal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  canChooseDesktopDirectory,
  canRevealDesktopPath,
  getPaperclipDesktopBridge,
  isRevealableDesktopPath,
} from "@/lib/desktop";

type Platform = "mac" | "windows" | "linux";

const platforms: { id: Platform; label: string; icon: typeof Apple }[] = [
  { id: "mac", label: "macOS", icon: Apple },
  { id: "windows", label: "Windows", icon: Monitor },
  { id: "linux", label: "Linux", icon: Terminal },
];

const instructions: Record<Platform, { steps: string[]; tip?: string }> = {
  mac: {
    steps: [
      "Open Finder and navigate to the folder.",
      "Right-click (or Control-click) the folder.",
      "Hold the Option (⌥) key — \"Copy\" changes to \"Copy as Pathname\".",
      "Click \"Copy as Pathname\", then paste here.",
    ],
    tip: "You can also open Terminal, type cd, drag the folder into the terminal window, and press Enter. Then type pwd to see the full path.",
  },
  windows: {
    steps: [
      "Open File Explorer and navigate to the folder.",
      "Click in the address bar at the top — the full path will appear.",
      "Copy the path, then paste here.",
    ],
    tip: "Alternatively, hold Shift and right-click the folder, then select \"Copy as path\".",
  },
  linux: {
    steps: [
      "Open a terminal and navigate to the directory with cd.",
      "Run pwd to print the full path.",
      "Copy the output and paste here.",
    ],
    tip: "In most file managers, Ctrl+L reveals the full path in the address bar.",
  },
};

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "mac";
  if (ua.includes("win")) return "windows";
  return "linux";
}

interface PathInstructionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PathInstructionsModal({
  open,
  onOpenChange,
}: PathInstructionsModalProps) {
  const [platform, setPlatform] = useState<Platform>(detectPlatform);

  const current = instructions[platform];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">How to get a full path</DialogTitle>
          <DialogDescription>
            Paste the absolute path (e.g.{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">/Users/you/project</code>
            ) into the input field.
          </DialogDescription>
        </DialogHeader>

        {/* Platform tabs */}
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          {platforms.map((p) => (
            <button
              key={p.id}
              type="button"
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                platform === p.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
              onClick={() => setPlatform(p.id)}
            >
              <p.icon className="h-3.5 w-3.5" />
              {p.label}
            </button>
          ))}
        </div>

        {/* Steps */}
        <ol className="space-y-2 text-sm">
          {current.steps.map((step, i) => (
            <li key={`${platform}-${step}`} className="flex gap-2">
              <span className="text-muted-foreground font-mono text-xs mt-0.5 shrink-0">
                {i + 1}.
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        {current.tip && (
          <p className="text-xs text-muted-foreground border-l-2 border-border pl-3">
            {current.tip}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shared path picker entrypoint.
 * On desktop builds this uses the native folder picker bridge. Browser builds
 * keep the manual path instructions fallback.
 */
export function ChoosePathButton({
  className,
  currentPath,
  onChoose,
  chooseLabel = "Choose",
  revealLabel = "Reveal in Finder",
}: {
  className?: string;
  currentPath?: string | null;
  onChoose?: (nextPath: string) => void;
  chooseLabel?: string;
  revealLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const desktopBridge = getPaperclipDesktopBridge();
  const canChoose = canChooseDesktopDirectory();
  const canReveal = canRevealDesktopPath() && isRevealableDesktopPath(currentPath);

  async function handleChoose() {
    if (canChoose && onChoose) {
      const chosen = await desktopBridge?.chooseDirectory?.();
      if (chosen) onChoose(chosen);
      return;
    }
    setOpen(true);
  }

  async function handleReveal() {
    const normalized = currentPath?.trim();
    if (!normalized || !canReveal) return;
    await desktopBridge?.revealPath?.(normalized);
  }

  return (
    <>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className={cn("text-muted-foreground", className)}
          onClick={() => {
            void handleChoose();
          }}
        >
          {chooseLabel}
        </Button>
        {canReveal ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => {
              void handleReveal();
            }}
          >
            {revealLabel}
          </Button>
        ) : null}
      </div>
      <PathInstructionsModal open={open} onOpenChange={setOpen} />
    </>
  );
}
