// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceEvals } from "./InstanceEvals";

const mockEvalsApi = vi.hoisted(() => ({
  getSummary: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockUseParams = vi.hoisted(() => vi.fn());

vi.mock("../api/evals", () => ({
  evalsApi: mockEvalsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: ReactNode;
    to: string;
    className?: string;
  }) => <a href={to} className={className}>{children}</a>,
  useParams: () => mockUseParams(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("InstanceEvals", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    mockUseParams.mockReset();
    mockSetBreadcrumbs.mockReset();
    Object.values(mockEvalsApi).forEach((mockFn) => mockFn.mockReset());

    mockUseParams.mockReturnValue({});
    mockEvalsApi.getSummary.mockResolvedValue({
      artifactSchemaVersion: 1,
      evalContractVersion: 1,
      scorecardVersion: 1,
      generatedAt: "2026-04-13T12:00:00.000Z",
      runCount: 1,
      latestRunId: "run-1",
      statusCounts: [{ status: "passed", count: 1 }],
      dimensions: [
        { dimension: "reliability", totalRuns: 1, acceptedOutcomes: 1, statusCounts: [{ status: "passed", count: 1 }], medianDurationMs: 3000, p95DurationMs: 3000, rolling7DayPassRate: 1, scopeViolationCount: 0 },
        { dimension: "stability", totalRuns: 0, acceptedOutcomes: 0, statusCounts: [], medianDurationMs: null, p95DurationMs: null, rolling7DayPassRate: null, scopeViolationCount: 0 },
        { dimension: "utility", totalRuns: 0, acceptedOutcomes: 0, statusCounts: [], medianDurationMs: null, p95DurationMs: null, rolling7DayPassRate: null, scopeViolationCount: 0 },
      ],
      scenarios: [],
      failingScenarios: [],
      runs: [],
    });
    mockEvalsApi.listRuns.mockResolvedValue([
      {
        runId: "run-1",
        scenarioId: "worker-isolation-across-projects",
        scenarioTitle: "Worker isolation across projects",
        bundleId: "architecture-canary",
        bundleLabel: "Architecture Canary",
        dimension: "reliability",
        layer: "invariant",
        horizonBucket: "15_60m",
        status: "passed",
        acceptedOutcome: true,
        startedAt: "2026-04-13T12:00:00.000Z",
        completedAt: "2026-04-13T12:00:03.000Z",
        durationMs: 3000,
        artifactDirectory: "runs/run-1",
        failureKinds: [],
        tags: ["scope"],
        sourceKind: "seeded",
      },
    ]);
    mockEvalsApi.getRun.mockResolvedValue(null);
  });

  afterEach(() => {
    queryClient.clear();
    container.remove();
  });

  it("renders the summary and recent runs", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <InstanceEvals />
        </QueryClientProvider>,
      );
    });

    await flush();

    expect(container.textContent).toContain("Architecture Evals");
    expect(container.textContent).toContain("Worker isolation across projects");
    expect(container.textContent).toContain("Seeded");
    expect(container.querySelector('a[href="/instance/settings/evals/run-1"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
