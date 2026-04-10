// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChoosePathButton } from "./PathInstructionsModal";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function Harness() {
  const [path, setPath] = useState("");
  return (
    <div>
      <input value={path} readOnly />
      <ChoosePathButton currentPath={path} onChoose={setPath} />
    </div>
  );
}

describe("ChoosePathButton", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    delete window.paperclipDesktop;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    delete window.paperclipDesktop;
  });

  it("uses the desktop bridge to choose a directory and reveal it in Finder", async () => {
    const chooseDirectory = vi.fn().mockResolvedValue("/Users/chason/code/paperclip");
    const revealPath = vi.fn().mockResolvedValue(undefined);
    window.paperclipDesktop = {
      chooseDirectory,
      revealPath,
    };

    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });

    const chooseButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Choose");
    expect(chooseButton).toBeDefined();

    await act(async () => {
      chooseButton?.click();
    });
    await flush();

    const input = container.querySelector("input");
    expect(chooseDirectory).toHaveBeenCalledTimes(1);
    expect(input?.value).toBe("/Users/chason/code/paperclip");

    const revealButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Reveal in Finder");
    expect(revealButton).toBeDefined();

    await act(async () => {
      revealButton?.click();
    });
    await flush();

    expect(revealPath).toHaveBeenCalledWith("/Users/chason/code/paperclip");
  });

  it("falls back to manual instructions when no desktop bridge is available", async () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });

    const chooseButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Choose");
    expect(chooseButton).toBeDefined();

    await act(async () => {
      chooseButton?.click();
    });
    await flush();

    expect(container.textContent).toContain("How to get a full path");
    expect(container.textContent).toContain("Paste the absolute path");
  });
});
