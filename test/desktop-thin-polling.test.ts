import { describe, expect, test } from "vitest";
import {
  mergeThinUiSnapshot,
  shouldIncludeColleaguesForTick
} from "../desktop-ui/thin_snapshot.js";

describe("desktop thin polling helpers", () => {
  test("includes colleagues immediately when none are known", () => {
    expect(shouldIncludeColleaguesForTick(1, false)).toBe(true);
    expect(shouldIncludeColleaguesForTick(5, false)).toBe(true);
  });

  test("throttles colleague refresh when colleagues are already known", () => {
    expect(shouldIncludeColleaguesForTick(1, true)).toBe(false);
    expect(shouldIncludeColleaguesForTick(2, true)).toBe(false);
    expect(shouldIncludeColleaguesForTick(6, true)).toBe(true);
  });

  test("merges thin monitor/inbox payload while preserving colleague cache", () => {
    const previous = {
      workspace_dir: "/tmp/ws",
      generated_at: "2026-02-10T00:00:00.000Z",
      index_sync_worker: { enabled: true, pending_workspaces: 0 },
      monitor: { rows: [{ run_id: "run_old" }] },
      review_inbox: { pending: [], recent_decisions: [] },
      colleagues: [{ agent_id: "agent_mgr", name: "Manager" }],
      comments: [{ id: "cmt_1" }]
    };
    const monitor = { rows: [{ run_id: "run_new" }] };
    const inbox = {
      pending: [{ artifact_id: "art_1" }],
      recent_decisions: [],
      parse_errors: { has_parse_errors: false, pending_with_errors: 0, decisions_with_errors: 0, max_parse_error_count: 0 }
    };

    const merged = mergeThinUiSnapshot({
      monitor,
      inbox,
      fullUi: null,
      previousSnapshot: previous
    }) as any;

    expect(merged.monitor.rows[0].run_id).toBe("run_new");
    expect(merged.review_inbox.pending[0].artifact_id).toBe("art_1");
    expect(merged.colleagues[0].agent_id).toBe("agent_mgr");
    expect(merged.comments[0].id).toBe("cmt_1");
    expect(merged.index_sync_worker.enabled).toBe(true);
  });
});
