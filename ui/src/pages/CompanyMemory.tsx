import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import type { MemoryFileSummary } from "@paperclipai/shared";
import { companiesApi } from "../api/companies";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { PackageFileTree, buildFileTree } from "../components/PackageFileTree";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

function isMarkdown(pathValue: string) {
  return pathValue.toLowerCase().endsWith(".md");
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CompanyMemory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { isMobile } = useSidebar();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState("index.md");
  const [draft, setDraft] = useState<string | null>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<string[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(["projects", "decisions", "systems", "playbooks", "people", "archive"]));
  const [showFilePanel, setShowFilePanel] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Company", href: "/company/settings" }, { label: "Memory" }]);
  }, [setBreadcrumbs]);

  const memoryQuery = useQuery({
    queryKey: queryKeys.companies.memory(selectedCompanyId ?? "__none__"),
    queryFn: () => companiesApi.memory(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const memory = memoryQuery.data;
  const fileOptions = useMemo(() => memory?.files.map((file) => file.path) ?? [], [memory]);
  const visibleFilePaths = useMemo(
    () => [...new Set(["RESOLVER.md", "index.md", ...fileOptions, ...pendingFiles])],
    [fileOptions, pendingFiles],
  );
  const fileTree = useMemo(
    () => buildFileTree(Object.fromEntries(visibleFilePaths.map((filePath) => [filePath, ""]))),
    [visibleFilePaths],
  );
  const selectedExists = fileOptions.includes(selectedFile);
  const selectedSummary = memory?.files.find((file) => file.path === selectedFile) ?? null;

  const fileQuery = useQuery({
    queryKey: queryKeys.companies.memoryFile(selectedCompanyId ?? "__none__", selectedFile),
    queryFn: () => companiesApi.memoryFile(selectedCompanyId!, selectedFile),
    enabled: Boolean(selectedCompanyId && selectedExists),
  });

  useEffect(() => {
    if (!memory) return;
    if (!fileOptions.includes(selectedFile) && !pendingFiles.includes(selectedFile)) {
      setSelectedFile(fileOptions.includes("index.md") ? "index.md" : fileOptions[0] ?? "index.md");
    }
  }, [fileOptions, memory, pendingFiles, selectedFile]);

  useEffect(() => {
    setDraft(null);
  }, [selectedFile, fileQuery.data?.content]);

  const saveFile = useMutation({
    mutationFn: (data: { path: string; content: string }) => companiesApi.saveMemoryFile(selectedCompanyId!, data),
    onSuccess: (_, variables) => {
      setPendingFiles((prev) => prev.filter((pathValue) => pathValue !== variables.path));
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.memory(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.memoryFile(selectedCompanyId!, variables.path) });
      pushToast({ tone: "success", title: "Company memory saved" });
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Failed to save company memory", body: err instanceof Error ? err.message : String(err) });
    },
  });

  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select a company to manage memory.</p>;
  if (memoryQuery.isLoading && !memory) return <PageSkeleton variant="list" />;
  if (!memory) return <p className="text-sm text-muted-foreground">Company memory is unavailable.</p>;

  const currentContent = selectedExists ? (fileQuery.data?.content ?? "") : "";
  const displayValue = draft ?? currentContent;
  const readOnly = Boolean(selectedSummary?.archived || fileQuery.data?.truncated);
  const dirty = draft !== null && draft !== currentContent;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Company Memory</h2>
        <p className="text-sm text-muted-foreground">
          Shared file-backed memory for reusable project, decision, system, and playbook context.
        </p>
      </div>

      <div className={cn("flex gap-0", isMobile && "flex-col gap-3")}>
        <div className={cn(
          "border border-border rounded-lg p-3 space-y-3 shrink-0",
          isMobile && showFilePanel && "block",
          isMobile && !showFilePanel && "hidden",
        )} style={isMobile ? undefined : { width: 300 }}>
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Files</h4>
            {!showNewFileInput && (
              <Button type="button" size="icon" variant="outline" className="h-7 w-7" onClick={() => setShowNewFileInput(true)}>
                +
              </Button>
            )}
          </div>
          {showNewFileInput && (
            <div className="space-y-2">
              <Input
                value={newFilePath}
                onChange={(event) => setNewFilePath(event.target.value)}
                placeholder="systems/runtime.md"
                className="font-mono text-sm"
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="flex-1"
                  disabled={!newFilePath.trim() || newFilePath.includes("..")}
                  onClick={() => {
                    const candidate = newFilePath.trim();
                    if (!candidate || candidate.includes("..")) return;
                    setPendingFiles((prev) => prev.includes(candidate) ? prev : [...prev, candidate]);
                    setSelectedFile(candidate);
                    setDraft("");
                    setNewFilePath("");
                    setShowNewFileInput(false);
                  }}
                >
                  Create
                </Button>
                <Button type="button" size="sm" variant="outline" className="flex-1" onClick={() => setShowNewFileInput(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <PackageFileTree
            nodes={fileTree}
            selectedFile={selectedFile}
            expandedDirs={expandedDirs}
            checkedFiles={new Set()}
            onToggleDir={(dirPath) => setExpandedDirs((current) => {
              const next = new Set(current);
              if (next.has(dirPath)) next.delete(dirPath);
              else next.add(dirPath);
              return next;
            })}
            onSelectFile={(filePath) => {
              setSelectedFile(filePath);
              if (!fileOptions.includes(filePath)) setDraft("");
              if (isMobile) setShowFilePanel(false);
            }}
            onToggleCheck={() => {}}
            showCheckboxes={false}
            renderFileExtra={(node) => {
              const file = memory.files.find((entry: MemoryFileSummary) => entry.path === node.path);
              if (!file) return null;
              return (
                <span className="ml-3 shrink-0 rounded border border-border text-muted-foreground px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {file.archived ? "archive" : formatBytes(file.size)}
                </span>
              );
            }}
          />
        </div>

        <div className={cn("border border-border rounded-lg p-4 space-y-3 min-w-0 flex-1", isMobile && showFilePanel && "hidden")}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {isMobile && (
                <Button type="button" size="icon" variant="outline" className="h-7 w-7 shrink-0" onClick={() => setShowFilePanel(true)}>
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              )}
              <div className="min-w-0">
                <h4 className="text-sm font-medium font-mono truncate">{selectedFile}</h4>
                <p className="text-xs text-muted-foreground">
                  {selectedExists ? `${selectedSummary?.layer ?? "memory"} file` : "New company memory file"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {dirty && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={saveFile.isPending}>
                  Cancel
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                onClick={() => saveFile.mutate({ path: selectedFile, content: displayValue })}
                disabled={readOnly || !dirty || saveFile.isPending}
              >
                {saveFile.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>

          {readOnly ? (
            <textarea
              value={displayValue}
              readOnly
              className="min-h-[520px] w-full rounded-md border border-border bg-muted/20 px-3 py-2 font-mono text-sm outline-none"
            />
          ) : isMarkdown(selectedFile) ? (
            <MarkdownEditor
              key={selectedFile}
              value={displayValue}
              onChange={(value) => setDraft(value ?? "")}
              placeholder="# Company memory"
              contentClassName="min-h-[520px] text-sm font-mono"
            />
          ) : (
            <textarea
              value={displayValue}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[520px] w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-sm outline-none"
              placeholder="Company memory file contents"
            />
          )}
        </div>
      </div>
    </div>
  );
}
