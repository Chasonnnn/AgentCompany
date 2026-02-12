import { describe, expect, test } from "vitest";
import {
  transitionSessionStatus,
  isTerminalSessionStatus,
  type SessionStatus
} from "../src/runtime/session_state.js";

describe("session state machine", () => {
  test("allows running -> terminal transitions", () => {
    expect(transitionSessionStatus("running", "ended")).toBe("ended");
    expect(transitionSessionStatus("running", "failed")).toBe("failed");
    expect(transitionSessionStatus("running", "stopped")).toBe("stopped");
  });

  test("terminal states are sticky", () => {
    const terminals: SessionStatus[] = ["ended", "failed", "stopped"];
    for (const status of terminals) {
      expect(transitionSessionStatus(status, status)).toBe(status);
      expect(isTerminalSessionStatus(status)).toBe(true);
    }
  });

  test("rejects invalid regressions from terminal to running", () => {
    expect(() => transitionSessionStatus("ended", "running")).toThrow(/invalid session status transition/i);
    expect(() => transitionSessionStatus("failed", "running")).toThrow(/invalid session status transition/i);
    expect(() => transitionSessionStatus("stopped", "running")).toThrow(/invalid session status transition/i);
  });
});
