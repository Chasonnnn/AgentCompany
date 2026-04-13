// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PacketMarkdownBody } from "./PacketMarkdownBody";

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div data-testid="markdown-body">{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("PacketMarkdownBody", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders structured packet summaries for supported frontmatter", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PacketMarkdownBody
          markdown={[
            "---",
            "kind: paperclip/heartbeat.v1",
            "state: yellow",
            'progress: "Parser landed, migration pending"',
            "nextActions:",
            '  - "Run migration"',
            "---",
            "",
            "Status note.",
          ].join("\n")}
        />,
      );
    });

    expect(container.textContent).toContain("Heartbeat");
    expect(container.textContent).toContain("Parser landed, migration pending");
    expect(container.textContent).toContain("Run migration");
    expect(container.textContent).toContain("Non-authoritative packet");
    expect(container.textContent).toContain("Status note.");

    await act(async () => {
      root.unmount();
    });
  });

  it("falls back to raw markdown when the frontmatter is not a Paperclip packet", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<PacketMarkdownBody markdown={"Just a normal comment."} />);
    });

    expect(container.textContent).toContain("Just a normal comment.");
    expect(container.textContent).not.toContain("Non-authoritative packet");

    await act(async () => {
      root.unmount();
    });
  });
});
