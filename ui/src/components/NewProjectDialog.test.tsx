// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectDialog } from "./NewProjectDialog";

const mockProjectsApi = vi.hoisted(() => ({
  create: vi.fn(),
  createWorkspace: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockGoalsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
}));

const closeNewProject = vi.fn();

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newProjectOpen: true,
    closeNewProject,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "AI Workforce" },
  }),
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/goals", () => ({
  goalsApi: mockGoalsApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) => (
    <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    className,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    className?: string;
  }) => (
    <button type={type ?? "button"} onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderDialog(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewProjectDialog />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("NewProjectDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockProjectsApi.create.mockResolvedValue({ id: "project-1" });
    mockProjectsApi.createWorkspace.mockResolvedValue({ id: "workspace-1" });
    mockAgentsApi.list.mockResolvedValue([]);
    mockGoalsApi.list.mockResolvedValue([]);
    mockAssetsApi.uploadImage.mockResolvedValue({ contentPath: "/asset.png" });
    closeNewProject.mockReset();
    window.paperclipDesktop = {
      chooseDirectory: vi.fn().mockResolvedValue("/Users/chason/code/surrogacyforce"),
    };
  });

  afterEach(() => {
    document.body.innerHTML = "";
    delete window.paperclipDesktop;
  });

  it("populates the local folder via the desktop picker without auto-submitting", async () => {
    renderDialog(container);
    await flush();

    const chooseButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Choose");
    expect(chooseButton).toBeDefined();

    await act(async () => {
      chooseButton?.click();
    });
    await flush();

    const pathInput = Array.from(container.querySelectorAll("input"))
      .find((input) => input.getAttribute("placeholder") === "/absolute/path/to/workspace");

    expect(pathInput?.value).toBe("/Users/chason/code/surrogacyforce");
    expect(mockProjectsApi.create).not.toHaveBeenCalled();
    expect(mockProjectsApi.createWorkspace).not.toHaveBeenCalled();
  });
});
