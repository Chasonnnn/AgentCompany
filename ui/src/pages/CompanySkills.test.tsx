// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySkills } from "./CompanySkills";

const mockCompanySkillsApi = vi.hoisted(() => ({
  list: vi.fn(),
  globalCatalog: vi.fn(),
  coverageAudit: vi.fn(),
  coverageRepairPreview: vi.fn(),
  coverageRepairApply: vi.fn(),
  installGlobal: vi.fn(),
  installAllGlobal: vi.fn(),
  bulkGrantPreview: vi.fn(),
  bulkGrantApply: vi.fn(),
  detail: vi.fn(),
  file: vi.fn(),
  updateStatus: vi.fn(),
  updateFile: vi.fn(),
  create: vi.fn(),
  importFromSource: vi.fn(),
  scanProjects: vi.fn(),
  installUpdate: vi.fn(),
  delete: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({
  navigation: vi.fn(),
}));
const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockTabsState = vi.hoisted(() => ({
  onValueChange: undefined as ((value: string) => void) | undefined,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} className={className} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({}),
}));

vi.mock("../api/companySkills", () => ({
  companySkillsApi: mockCompanySkillsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
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

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading…</div>,
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => <textarea value={value} readOnly />,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tabs", () => {
  return {
    Tabs: ({
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange?: (value: string) => void;
      children: ReactNode;
    }) => {
      mockTabsState.onValueChange = onValueChange;
      return <div>{children}</div>;
    },
    TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    TabsTrigger: ({ value, children }: { value: string; children: ReactNode }) => (
      <button type="button" onClick={() => mockTabsState.onValueChange?.(value)}>
        {children}
      </button>
    ),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("CompanySkills", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    mockTabsState.onValueChange = undefined;
    mockNavigate.mockReset();
    mockSetBreadcrumbs.mockReset();
    mockPushToast.mockReset();
    Object.values(mockCompanySkillsApi).forEach((mockFn) => mockFn.mockReset());
    Object.values(mockAgentsApi).forEach((mockFn) => mockFn.mockReset());
    Object.values(mockAuthApi).forEach((mockFn) => mockFn.mockReset());
    mockCompanySkillsApi.list.mockResolvedValue([]);
    mockCompanySkillsApi.coverageAudit.mockResolvedValue({
      companyId: "company-1",
      auditedAgentCount: 2,
      coveredCount: 1,
      repairableGapCount: 1,
      nonrepairableGapCount: 0,
      customizedCount: 0,
      plannedImports: [
        {
          slug: "investigate",
          name: "Investigate",
          sourcePath: "/Users/chason/gstack/.agents/skills/gstack-investigate",
          expectedKey: "local/e780050bf1/investigate",
        },
      ],
      agents: [
        {
          id: "agent-1",
          name: "Technical Project Lead",
          urlKey: "technical-project-lead",
          role: "engineer",
          title: "Technical Project Lead",
          operatingClass: "project_leadership",
          archetypeKey: "technical_project_lead",
          status: "repairable_gap",
          repairable: true,
          expectedSkillSlugs: ["investigate", "review"],
          resolvedExpectedSkills: [],
          requiredSkillKeys: [],
          currentDesiredSkills: [],
          nextDesiredSkills: ["local/e780050bf1/investigate", "local/97804d2edd/review"],
          missingSkillSlugs: ["investigate", "review"],
          ambiguousSkillSlugs: [],
          preservedCustomSkillKeys: [],
          note: "Repairs 2 missing default skills.",
        },
      ],
    });
    mockCompanySkillsApi.coverageRepairPreview.mockResolvedValue({
      companyId: "company-1",
      auditedAgentCount: 2,
      coveredCount: 1,
      repairableGapCount: 1,
      nonrepairableGapCount: 0,
      customizedCount: 0,
      plannedImports: [
        {
          slug: "investigate",
          name: "Investigate",
          sourcePath: "/Users/chason/gstack/.agents/skills/gstack-investigate",
          expectedKey: "local/e780050bf1/investigate",
        },
      ],
      agents: [
        {
          id: "agent-1",
          name: "Technical Project Lead",
          urlKey: "technical-project-lead",
          role: "engineer",
          title: "Technical Project Lead",
          operatingClass: "project_leadership",
          archetypeKey: "technical_project_lead",
          status: "repairable_gap",
          repairable: true,
          expectedSkillSlugs: ["investigate", "review"],
          resolvedExpectedSkills: [],
          requiredSkillKeys: [],
          currentDesiredSkills: [],
          nextDesiredSkills: ["local/e780050bf1/investigate", "local/97804d2edd/review"],
          missingSkillSlugs: ["investigate", "review"],
          ambiguousSkillSlugs: [],
          preservedCustomSkillKeys: [],
          note: "Repairs 2 missing default skills.",
        },
      ],
      changedAgentCount: 1,
      selectionFingerprint: "coverage-fingerprint-1",
    });
    mockCompanySkillsApi.coverageRepairApply.mockResolvedValue({
      companyId: "company-1",
      changedAgentCount: 1,
      appliedAgentIds: ["agent-1"],
      importedSkills: [],
      rollbackPerformed: false,
      rollbackErrors: [],
      selectionFingerprint: "coverage-fingerprint-1",
      audit: {
        companyId: "company-1",
        auditedAgentCount: 2,
        coveredCount: 2,
        repairableGapCount: 0,
        nonrepairableGapCount: 0,
        customizedCount: 0,
        plannedImports: [],
        agents: [],
      },
    });
    mockCompanySkillsApi.globalCatalog.mockResolvedValue([
      {
        catalogKey: "global/codex/abc123/design-guide",
        slug: "design-guide",
        name: "Design Guide",
        description: "Design system rules for contributors.",
        sourceRoot: "codex",
        sourcePath: "/Users/chason/.codex/skills/design-guide",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        manifestVersion: 1,
        identityDigest: "identity-design-guide",
        contentDigest: "content-design-guide",
        verificationState: "verified",
        compatibilityMetadata: null,
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        installedSkillId: null,
        installedSkillKey: null,
      },
    ]);
    mockCompanySkillsApi.installGlobal.mockResolvedValue({
      id: "skill-1",
      companyId: "company-1",
      key: "local/abc123/design-guide",
      slug: "design-guide",
      name: "Design Guide",
      description: "Installed design guide",
      markdown: "# Design Guide",
      sourceType: "catalog",
      sourceLocator: "/Users/chason/.paperclip/skills/company-1/__catalog__/design-guide",
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      manifestVersion: 1,
      identityDigest: "identity-design-guide",
      contentDigest: "content-design-guide",
      sourceVerifiedAt: new Date("2026-04-10T12:00:00.000Z"),
      verificationState: "verified",
      compatibilityMetadata: null,
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: {
        sourceKind: "global_catalog",
        catalogKey: "global/codex/abc123/design-guide",
        catalogSourceRoot: "codex",
      },
      createdAt: new Date("2026-04-10T12:00:00.000Z"),
      updatedAt: new Date("2026-04-10T12:00:00.000Z"),
    });
    mockCompanySkillsApi.installAllGlobal.mockResolvedValue({
      discoverableCount: 1,
      installedCount: 1,
      alreadyInstalledCount: 0,
      skipped: [],
      installed: [],
    });
    mockCompanySkillsApi.bulkGrantPreview.mockResolvedValue({
      skillId: "skill-1",
      skillKey: "local/abc123/design-guide",
      skillName: "Design Guide",
      target: {
        kind: "department",
        departmentKey: "engineering",
        label: "Engineering",
      },
      tier: "leaders",
      mode: "add",
      matchedAgentCount: 1,
      changedAgentCount: 1,
      addCount: 1,
      removeCount: 0,
      unchangedCount: 0,
      agents: [
        {
          id: "agent-1",
          name: "CTO",
          urlKey: "cto",
          role: "cto",
          title: "Chief Technology Officer",
          currentDesiredSkills: [],
          nextDesiredSkills: ["local/abc123/design-guide"],
          change: "add",
        },
      ],
      skippedAgents: [],
      selectionFingerprint: "fingerprint-1",
    });
    mockCompanySkillsApi.bulkGrantApply.mockResolvedValue({
      skillId: "skill-1",
      skillKey: "local/abc123/design-guide",
      skillName: "Design Guide",
      target: {
        kind: "department",
        departmentKey: "engineering",
        label: "Engineering",
      },
      tier: "leaders",
      mode: "add",
      matchedAgentCount: 1,
      changedAgentCount: 1,
      addCount: 1,
      removeCount: 0,
      unchangedCount: 0,
      appliedAgentIds: ["agent-1"],
      rollbackPerformed: false,
      rollbackErrors: [],
    });
    mockAgentsApi.navigation.mockResolvedValue({
      layout: "department",
      executives: [],
      departments: [
        {
          key: "engineering",
          name: "Engineering",
          leaders: [],
          projects: [],
        },
      ],
      projectPods: [
        {
          projectId: "project-1",
          projectName: "Alpha",
          color: null,
          leaders: [],
          teams: [],
          workers: [],
        },
      ],
      sharedServices: [],
      unassigned: [],
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "board@example.com", name: "Board" },
    });
  });

  afterEach(() => {
    queryClient.clear();
    container.remove();
  });

  it("previews and applies an active workforce coverage repair", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySkills />
        </QueryClientProvider>,
      );
    });

    await flush();

    expect(mockCompanySkillsApi.coverageAudit).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Active Workforce Coverage");
    expect(container.textContent).toContain("Technical Project Lead");

    const previewButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Preview repair"));
    expect(previewButton).toBeDefined();

    await act(async () => {
      previewButton?.click();
    });
    await flush();

    expect(mockCompanySkillsApi.coverageRepairPreview).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Apply to 1 agent");

    const applyButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Apply to 1 agent"));
    expect(applyButton).toBeDefined();

    await act(async () => {
      applyButton?.click();
    });
    await flush();

    expect(mockCompanySkillsApi.coverageRepairApply).toHaveBeenCalledWith("company-1", {
      selectionFingerprint: "coverage-fingerprint-1",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("switches to the global catalog view and installs a selected global skill", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySkills />
        </QueryClientProvider>,
      );
    });

    await flush();

    const sourceInput = Array.from(container.querySelectorAll("input"))
      .find((input) => input.getAttribute("placeholder") === "Paste path, GitHub URL, or skills.sh command");
    expect(sourceInput).toBeDefined();

    const globalTab = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Global Catalog");
    expect(globalTab).toBeDefined();

    await act(async () => {
      globalTab?.click();
    });
    await flush();

    expect(mockCompanySkillsApi.globalCatalog).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Install a read-only snapshot into this company before assigning a skill to agents.");
    expect(container.textContent).toContain("Design Guide");
    expect(container.textContent).toContain("Install to company");

    const installButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Install to company"));
    expect(installButton).toBeDefined();

    await act(async () => {
      installButton?.click();
    });
    await flush();

    expect(mockCompanySkillsApi.installGlobal).toHaveBeenCalledWith("company-1", {
      catalogKey: "global/codex/abc123/design-guide",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("installs every discoverable global skill from the global catalog header", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySkills />
        </QueryClientProvider>,
      );
    });

    await flush();

    const globalTab = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Global Catalog");
    expect(globalTab).toBeDefined();

    await act(async () => {
      globalTab?.click();
    });
    await flush();

    const installAllButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Install all"));
    expect(installAllButton).toBeDefined();

    await act(async () => {
      installAllButton?.click();
    });
    await flush();

    expect(mockCompanySkillsApi.installAllGlobal).toHaveBeenCalledWith("company-1");

    await act(async () => {
      root.unmount();
    });
  });

  it("previews and applies a bulk skill grant from installed skill detail", async () => {
    mockCompanySkillsApi.list.mockResolvedValue([
      {
        id: "skill-1",
        companyId: "company-1",
        key: "local/abc123/design-guide",
        slug: "design-guide",
        name: "Design Guide",
        description: "Installed design guide",
        sourceType: "catalog",
        sourceLocator: "/Users/chason/.paperclip/skills/company-1/design-guide",
        sourceRef: null,
        sourceLabel: "Paperclip",
        sourceBadge: "paperclip",
        editable: false,
        editableReason: "Managed catalog skill",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        manifestVersion: 1,
        identityDigest: "identity-design-guide",
        contentDigest: "content-design-guide",
        sourceVerifiedAt: new Date("2026-04-10T12:00:00.000Z"),
        verificationState: "verified",
        compatibilityMetadata: null,
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: {},
        usedByAgents: [],
        createdAt: new Date("2026-04-10T12:00:00.000Z"),
        updatedAt: new Date("2026-04-10T12:00:00.000Z"),
      },
    ]);
    mockCompanySkillsApi.detail.mockResolvedValue({
      id: "skill-1",
      companyId: "company-1",
      key: "local/abc123/design-guide",
      slug: "design-guide",
      name: "Design Guide",
      description: "Installed design guide",
      sourceType: "catalog",
      sourceLocator: "/Users/chason/.paperclip/skills/company-1/design-guide",
      sourceRef: null,
      sourceLabel: "Paperclip",
      sourceBadge: "paperclip",
      editable: false,
      editableReason: "Managed catalog skill",
      trustLevel: "markdown_only",
      compatibility: "compatible",
      manifestVersion: 1,
      identityDigest: "identity-design-guide",
      contentDigest: "content-design-guide",
      sourceVerifiedAt: new Date("2026-04-10T12:00:00.000Z"),
      verificationState: "verified",
      compatibilityMetadata: null,
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: {},
      usedByAgents: [],
      createdAt: new Date("2026-04-10T12:00:00.000Z"),
      updatedAt: new Date("2026-04-10T12:00:00.000Z"),
    });
    mockCompanySkillsApi.file.mockResolvedValue({
      path: "SKILL.md",
      content: "# Design Guide",
      markdown: true,
      editable: false,
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySkills />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    const openDialogButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Grant to group"));
    expect(openDialogButton).toBeDefined();

    await act(async () => {
      openDialogButton?.click();
    });
    await flush();

    expect(mockAgentsApi.navigation).toHaveBeenCalledWith("company-1", "department");

    const previewButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Preview changes"));
    expect(previewButton).toBeDefined();

    await act(async () => {
      previewButton?.click();
    });
    await flush();

    expect(mockCompanySkillsApi.bulkGrantPreview).toHaveBeenCalledWith("company-1", "skill-1", {
      target: { kind: "department", departmentKey: "executive" },
      tier: "all",
      mode: "add",
    });
    expect(container.textContent).toContain("Matched agents");
    expect(container.textContent).toContain("CTO");

    const applyButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Apply to 1 agent"));
    expect(applyButton).toBeDefined();

    await act(async () => {
      applyButton?.click();
    });
    await flush();

    expect(mockCompanySkillsApi.bulkGrantApply).toHaveBeenCalledWith("company-1", "skill-1", {
      target: { kind: "department", departmentKey: "executive" },
      tier: "all",
      mode: "add",
      selectionFingerprint: "fingerprint-1",
    });

    await act(async () => {
      root.unmount();
    });
  });
});
