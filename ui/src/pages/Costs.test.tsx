// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";

const mockBudgetsApi = vi.hoisted(() => ({
  overview: vi.fn(),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));

const mockCostsApi = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
  byProject: vi.fn(),
  byAgentModel: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
  windowSpend: vi.fn(),
  quotaWindows: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("../api/budgets", () => ({
  budgetsApi: mockBudgetsApi,
}));

vi.mock("../api/costs", () => ({
  costsApi: mockCostsApi,
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

vi.mock("../hooks/useDateRange", () => ({
  PRESET_KEYS: ["mtd"],
  PRESET_LABELS: { mtd: "MTD" },
  useDateRange: () => ({
    preset: "mtd",
    setPreset: vi.fn(),
    customFrom: "",
    setCustomFrom: vi.fn(),
    customTo: "",
    setCustomTo: vi.fn(),
    from: undefined,
    to: undefined,
    customReady: true,
  }),
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading…</div>,
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/BudgetIncidentCard", () => ({
  BudgetIncidentCard: () => <div>Budget incident</div>,
}));

vi.mock("../components/BudgetPolicyCard", () => ({
  BudgetPolicyCard: () => <div>Budget policy</div>,
}));

vi.mock("../components/FinanceTimelineCard", () => ({
  FinanceTimelineCard: () => <div>Finance timeline</div>,
}));

vi.mock("../components/FinanceBillerCard", () => ({
  FinanceBillerCard: () => <div>Finance biller</div>,
}));

vi.mock("../components/FinanceKindCard", () => ({
  FinanceKindCard: () => <div>Finance kind</div>,
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: () => <div>Page tabs</div>,
}));

vi.mock("../components/ProviderQuotaCard", () => ({
  ProviderQuotaCard: () => <div>Provider card</div>,
}));

vi.mock("../components/BillerSpendCard", () => ({
  BillerSpendCard: () => <div>Biller card</div>,
}));

vi.mock("../components/Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Costs", () => {
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

    mockSetBreadcrumbs.mockReset();
    Object.values(mockBudgetsApi).forEach((mockFn) => mockFn.mockReset());
    Object.values(mockCostsApi).forEach((mockFn) => mockFn.mockReset());

    mockBudgetsApi.overview.mockResolvedValue({
      companyId: "company-1",
      policies: [],
      activeIncidents: [],
      pausedAgentCount: 0,
      pausedProjectCount: 0,
      pendingApprovalCount: 0,
    });

    mockCostsApi.summary.mockResolvedValue({
      companyId: "company-1",
      spendCents: 0,
      estimatedApiCostCents: 12_345,
      budgetCents: 50_000,
      utilizationPercent: 0,
    });
    mockCostsApi.byAgent.mockResolvedValue([
      {
        agentId: "agent-1",
        agentName: "CEO",
        agentStatus: "active",
        costCents: 0,
        inputTokens: 4_700_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 55_000,
        estimatedApiCostCents: 12_345,
        apiRunCount: 0,
        subscriptionRunCount: 10,
        subscriptionCachedInputTokens: 0,
        subscriptionCacheCreationInputTokens: 0,
        subscriptionInputTokens: 4_700_000,
        subscriptionOutputTokens: 55_000,
      },
    ]);
    mockCostsApi.byAgentModel.mockResolvedValue([
      {
        agentId: "agent-1",
        agentName: "CEO",
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.4",
        costCents: 0,
        inputTokens: 4_700_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 55_000,
        estimatedApiCostCents: 12_345,
      },
    ]);
    mockCostsApi.byProject.mockResolvedValue([
      {
        projectId: "project-1",
        projectName: "Control Plane",
        costCents: 0,
        inputTokens: 4_700_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 55_000,
        estimatedApiCostCents: 12_345,
      },
    ]);
    mockCostsApi.byProvider.mockResolvedValue([]);
    mockCostsApi.byBiller.mockResolvedValue([]);
    mockCostsApi.windowSpend.mockResolvedValue([]);
    mockCostsApi.quotaWindows.mockResolvedValue([]);
    mockCostsApi.financeSummary.mockResolvedValue({
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
    mockCostsApi.financeByBiller.mockResolvedValue([]);
    mockCostsApi.financeByKind.mockResolvedValue([]);
    mockCostsApi.financeEvents.mockResolvedValue([]);
  });

  afterEach(() => {
    queryClient.clear();
    container.remove();
  });

  it("shows billed spend and api-equivalent estimates separately on the overview", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Costs />
        </QueryClientProvider>,
      );
    });

    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain("Inference spend");
    expect(text).toContain("API-equivalent");
    expect(text).toContain("$0.00");
    expect(text).toContain("$123.45");
    expect(text).toContain("Codex + Claude only");
    expect(text).toContain("budgets use billed spend");
    expect(text).toContain("CEO");
    expect(text).toContain("Control Plane");
  });
});
