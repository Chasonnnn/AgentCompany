// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewAgent } from "./NewAgent";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  adapterModels: vi.fn(),
  hire: vi.fn(),
}));

const mockCompanySkillsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} className={className} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/companySkills", () => ({
  companySkillsApi: mockCompanySkillsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../components/agent-config-primitives", () => ({
  roleLabels: {
    ceo: "CEO",
    general: "General",
  },
}));

vi.mock("../components/AgentConfigForm", () => ({
  AgentConfigForm: () => <div>Agent config form</div>,
}));

vi.mock("../components/ReportsToPicker", () => ({
  ReportsToPicker: () => <div>Reports to picker</div>,
}));

vi.mock("../adapters", () => ({
  getUIAdapter: () => ({
    buildAdapterConfig: () => ({}),
  }),
  listUIAdapters: () => [],
}));

vi.mock("../adapters/metadata", () => ({
  isValidAdapterType: () => true,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant: _variant,
    size: _size,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    id,
    checked,
    onCheckedChange,
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  Shield: () => <span aria-hidden="true">shield</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("NewAgent", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    mockNavigate.mockReset();
    mockSetBreadcrumbs.mockReset();
    mockAgentsApi.list.mockReset();
    mockAgentsApi.adapterModels.mockReset();
    mockAgentsApi.hire.mockReset();
    mockCompanySkillsApi.list.mockReset();
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockCompanySkillsApi.list.mockResolvedValue([
      {
        id: "skill-bundled",
        key: "paperclipai/paperclip/paperclip-create-agent",
        name: "Paperclip Create Agent",
        description: "Governance-aware agent hiring workflow.",
      },
      {
        id: "skill-custom",
        key: "company/company-1/custom-skill",
        name: "Custom Skill",
        description: "Custom company process.",
      },
    ]);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
  });

  it("shows bundled Paperclip skills alongside other company skills in the create form", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewAgent />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    expect(mockCompanySkillsApi.list).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Paperclip Create Agent");
    expect(container.textContent).toContain("Custom Skill");
    expect(container.textContent).toContain("Bundled Paperclip runtime skills remain available automatically.");
    expect(container.textContent).not.toContain("No company skills installed yet.");
  });
});
