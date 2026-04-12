// @vitest-environment node

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAgentMentionHref, buildProjectMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";
import { queryKeys } from "../lib/queryKeys";

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

function renderMarkdown(children: string, options?: {
  seededIssues?: Array<{ identifier: string; status: string }>;
  softBreaks?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  for (const issue of options?.seededIssues ?? []) {
    queryClient.setQueryData(queryKeys.issues.detail(issue.identifier), {
      id: issue.identifier,
      identifier: issue.identifier,
      status: issue.status,
    });
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MarkdownBody softBreaks={options?.softBreaks}>{children}</MarkdownBody>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("MarkdownBody", () => {
  it("renders markdown images without a resolver", () => {
    const html = renderMarkdown("![](/api/attachments/test/content)");

    expect(html).toContain('<img src="/api/attachments/test/content" alt=""/>');
  });

  it("resolves relative image paths when a resolver is provided", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MarkdownBody resolveImageSrc={(src) => `/resolved/${src}`}>
            {"![Org chart](images/org-chart.png)"}
          </MarkdownBody>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain('src="/resolved/images/org-chart.png"');
    expect(html).toContain('alt="Org chart"');
  });

  it("renders agent, project, and skill mentions as chips", () => {
    const html = renderMarkdown(
      `[@CodexCoder](${buildAgentMentionHref("agent-123", "code")}) [@Paperclip App](${buildProjectMentionHref("project-456", "#336699")}) [/release-changelog](${buildSkillMentionHref("skill-789", "release-changelog")})`,
    );

    expect(html).toContain('href="/agents/agent-123"');
    expect(html).toContain('data-mention-kind="agent"');
    expect(html).toContain("--paperclip-mention-icon-mask");
    expect(html).toContain('href="/projects/project-456"');
    expect(html).toContain('data-mention-kind="project"');
    expect(html).toContain("--paperclip-mention-project-color:#336699");
    expect(html).toContain('href="/skills/skill-789"');
    expect(html).toContain('data-mention-kind="skill"');
  });

  it("renders soft breaks when explicitly enabled", () => {
    const html = renderMarkdown("First line\nSecond line", { softBreaks: true });

    expect(html).toContain("First line<br/>");
    expect(html).toContain("Second line");
  });

  it("does not render soft breaks by default", () => {
    const html = renderMarkdown("First line\nSecond line");

    expect(html).not.toContain("<br/>");
  });

  it("linkifies bare issue identifiers in markdown text", () => {
    const html = renderMarkdown("Depends on PAP-1271 for the hover state.", {
      seededIssues: [{ identifier: "PAP-1271", status: "done" }],
    });

    expect(html).toContain('href="/issues/PAP-1271"');
    expect(html).toContain("text-green-600");
    expect(html).toContain(">PAP-1271<");
  });

  it("rewrites full issue URLs to internal issue links", () => {
    const html = renderMarkdown("See http://localhost:3100/PAP/issues/PAP-1179.", {
      seededIssues: [{ identifier: "PAP-1179", status: "blocked" }],
    });

    expect(html).toContain('href="/issues/PAP-1179"');
    expect(html).toContain("text-red-600");
    expect(html).toContain(">http://localhost:3100/PAP/issues/PAP-1179<");
  });

  it("linkifies issue identifiers inside inline code spans", () => {
    const html = renderMarkdown("Reference `PAP-1271` here.", {
      seededIssues: [{ identifier: "PAP-1271", status: "done" }],
    });

    expect(html).toContain('href="/issues/PAP-1271"');
    expect(html).toContain("<code>PAP-1271</code>");
    expect(html).toContain("text-green-600");
  });
});
