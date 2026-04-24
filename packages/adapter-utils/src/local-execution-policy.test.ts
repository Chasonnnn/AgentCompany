import { describe, expect, it } from "vitest";
import {
  applyLocalExecutionPolicy,
  LocalExecutionPolicyError,
  parseLocalExecutionPolicy,
  permissiveLocalExecutionPolicy,
} from "./local-execution-policy.js";

describe("local execution policy", () => {
  it("parses an allowlist policy object", () => {
    expect(
      parseLocalExecutionPolicy({
        preset: "test_runner",
        allowedCommands: ["node"],
        allowedEnvKeys: ["PATH", "HOME"],
        allowedFsPaths: ["/tmp/worktree"],
        allowedNetwork: "off",
      }),
    ).toEqual({
      preset: "test_runner",
      allowedCommands: ["node"],
      allowedEnvKeys: ["PATH", "HOME"],
      allowedFsPaths: ["/tmp/worktree"],
      allowedNetwork: "none",
    });
  });

  it("blocks commands outside the allowlist", () => {
    const policy = parseLocalExecutionPolicy({
      preset: "test_runner",
      allowedCommands: ["node"],
    })!;

    expect(() =>
      applyLocalExecutionPolicy({
        policy,
        executionKind: "local",
        command: "/bin/bash",
        cwd: "/tmp/worktree",
        env: {},
      }),
    ).toThrowError(LocalExecutionPolicyError);
  });

  it("blocks working directories outside allowed roots", () => {
    const policy = parseLocalExecutionPolicy({
      preset: "test_runner",
      allowedFsPaths: ["/tmp/worktree"],
    })!;

    expect(() =>
      applyLocalExecutionPolicy({
        policy,
        executionKind: "local",
        command: "/usr/bin/node",
        cwd: "/tmp/elsewhere",
        env: {},
      }),
    ).toThrowError(/blocked working directory/i);
  });

  it("filters env to the allowlist and rejects disallowed declared keys", () => {
    const policy = parseLocalExecutionPolicy({
      preset: "test_runner",
      allowedEnvKeys: ["PATH", "HOME"],
    })!;

    expect(
      applyLocalExecutionPolicy({
        policy,
        executionKind: "local",
        command: "/usr/bin/node",
        cwd: "/tmp/worktree",
        env: {
          PATH: "/usr/bin",
          HOME: "/tmp/home",
          SECRET_KEY: "hidden",
        },
      }),
    ).toEqual({
      env: {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
      },
    });

    expect(() =>
      applyLocalExecutionPolicy({
        policy,
        executionKind: "local",
        command: "/usr/bin/node",
        cwd: "/tmp/worktree",
        env: {
          PATH: "/usr/bin",
          HOME: "/tmp/home",
          SECRET_KEY: "hidden",
        },
        declaredEnvKeys: ["SECRET_KEY"],
      }),
    ).toThrowError(/blocked env keys/i);
  });

  it("passes remote execution and permissive policies through unchanged", () => {
    const env = { PATH: "/usr/bin", HOME: "/tmp/home" };
    expect(
      applyLocalExecutionPolicy({
        policy: parseLocalExecutionPolicy({ preset: "test_runner", allowedCommands: ["node"] }),
        executionKind: "remote",
        command: "/usr/bin/ssh",
        cwd: "/tmp/worktree",
        env,
      }),
    ).toEqual({ env });

    expect(
      applyLocalExecutionPolicy({
        policy: permissiveLocalExecutionPolicy(),
        executionKind: "local",
        command: "/usr/bin/node",
        cwd: "/tmp/worktree",
        env,
      }),
    ).toEqual({ env });
  });
});
