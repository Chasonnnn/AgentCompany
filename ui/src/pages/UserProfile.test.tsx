// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserProfile } from "./UserProfile";

const getUserProfileMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("../api/userProfiles", () => ({
  userProfilesApi: {
    get: (companyId: string, userSlug: string) => getUserProfileMock(companyId, userSlug),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: setBreadcrumbsMock,
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useParams: () => ({ userSlug: "dotta" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("UserProfile", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getUserProfileMock.mockResolvedValue({
      user: {
        id: "user-1",
        slug: "dotta",
        name: "Dotta",
        email: "dotta@example.com",
        image: null,
        membershipRole: "owner",
        membershipStatus: "active",
        joinedAt: "2026-04-10T00:00:00.000Z",
      },
      stats: [
        {
          key: "last7",
          label: "Last 7 days",
          touchedIssues: 2,
          createdIssues: 1,
          completedIssues: 1,
          assignedOpenIssues: 1,
          commentCount: 3,
          activityCount: 4,
          costCents: 25,
          inputTokens: 120,
          cachedInputTokens: 30,
          outputTokens: 45,
          costEventCount: 1,
        },
        {
          key: "last30",
          label: "Last 30 days",
          touchedIssues: 3,
          createdIssues: 2,
          completedIssues: 1,
          assignedOpenIssues: 1,
          commentCount: 4,
          activityCount: 5,
          costCents: 30,
          inputTokens: 150,
          cachedInputTokens: 40,
          outputTokens: 55,
          costEventCount: 1,
        },
        {
          key: "all",
          label: "All time",
          touchedIssues: 5,
          createdIssues: 3,
          completedIssues: 2,
          assignedOpenIssues: 1,
          commentCount: 6,
          activityCount: 7,
          costCents: 42,
          inputTokens: 220,
          cachedInputTokens: 60,
          outputTokens: 75,
          costEventCount: 2,
        },
      ],
      daily: Array.from({ length: 14 }, (_, index) => ({
        date: `2026-04-${String(index + 1).padStart(2, "0")}`,
        activityCount: index % 2,
        completedIssues: index % 3 === 0 ? 1 : 0,
        costCents: index,
        inputTokens: 10 * index,
        cachedInputTokens: index,
        outputTokens: 5 * index,
      })),
      recentIssues: [
        {
          id: "issue-1",
          identifier: "PAP-1",
          title: "Review onboarding flow",
          status: "done",
          priority: "high",
          assigneeAgentId: null,
          assigneeUserId: "user-1",
          updatedAt: "2026-04-20T00:00:00.000Z",
          completedAt: "2026-04-20T00:00:00.000Z",
        },
      ],
      recentActivity: [
        {
          id: "activity-1",
          action: "issue.updated",
          entityType: "issue",
          entityId: "issue-1",
          details: null,
          createdAt: "2026-04-20T00:00:00.000Z",
        },
      ],
      topAgents: [
        {
          agentId: "agent-1",
          agentName: "Coder",
          costCents: 42,
          inputTokens: 220,
          cachedInputTokens: 60,
          outputTokens: 75,
        },
      ],
      topProviders: [
        {
          provider: "openai",
          biller: "openai",
          model: "gpt-5.4",
          costCents: 42,
          inputTokens: 220,
          cachedInputTokens: 60,
          outputTokens: 75,
        },
      ],
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the main user profile sections", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <UserProfile />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Dotta");
    expect(container.textContent).toContain("@dotta");
    expect(container.textContent).toContain("Recent tasks");
    expect(container.textContent).toContain("Recent activity");
    expect(container.textContent).toContain("Agent attribution");
    expect(container.textContent).toContain("Provider mix");
    expect(container.textContent).toContain("Review onboarding flow");

    expect(getUserProfileMock).toHaveBeenCalledWith("company-1", "dotta");
    expect(setBreadcrumbsMock).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});
