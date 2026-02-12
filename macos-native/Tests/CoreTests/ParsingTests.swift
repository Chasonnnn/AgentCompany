import XCTest
@testable import AgentCompanyNativeCore

final class ParsingTests: XCTestCase {
  func testParseProjectsFromWorkspaceResponse() throws {
    let raw = #"""
    {
      "workspace_dir": "/tmp/work",
      "projects": [
        {
          "project_id": "project_alpha",
          "name": "Alpha",
          "pending_reviews": 2,
          "active_runs": 1,
          "task_count": 9,
          "progress_pct": 56,
          "blocked_tasks": 1,
          "risk_flags": ["delayed"]
        }
      ]
    }
    """#

    let value = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
    let projects = RPCHelpers.parseProjects(value)

    XCTAssertEqual(projects.count, 1)
    XCTAssertEqual(projects[0].id, "project_alpha")
    XCTAssertEqual(projects[0].name, "Alpha")
    XCTAssertEqual(projects[0].pendingReviews, 2)
    XCTAssertEqual(projects[0].activeRuns, 1)
    XCTAssertEqual(projects[0].taskCount, 9)
    XCTAssertEqual(projects[0].progressPct, 56)
    XCTAssertEqual(projects[0].blockedTasks, 1)
    XCTAssertEqual(projects[0].riskFlags, ["delayed"])
  }

  func testParseRecommendations() throws {
    let raw = #"""
    {
      "recommendations": [
        {
          "task_id": "task_1",
          "preferred_provider": "codex",
          "preferred_model": "gpt-5-codex",
          "preferred_agent_id": "agent_dev_1",
          "token_budget_hint": 20000,
          "reason": "Backend-heavy implementation work"
        }
      ]
    }
    """#

    let value = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
    let rows = RPCHelpers.parseRecommendations(value)

    XCTAssertEqual(rows.count, 1)
    XCTAssertEqual(rows[0].taskID, "task_1")
    XCTAssertEqual(rows[0].preferredProvider, "codex")
    XCTAssertEqual(rows[0].preferredModel, "gpt-5-codex")
    XCTAssertEqual(rows[0].preferredAgentID, "agent_dev_1")
    XCTAssertEqual(rows[0].tokenBudgetHint, 20000)
  }

  func testParseActivitiesSortsNewestFirst() throws {
    let raw = #"""
    {
      "review_inbox": {
        "pending": [
          {
            "artifact_id": "art_1",
            "artifact_type": "report",
            "title": "Daily Summary",
            "produced_by": "agent_ops",
            "created_at": "2026-02-10T10:00:00Z"
          }
        ],
        "recent_decisions": [
          {
            "subject_artifact_id": "art_2",
            "decision": "approved",
            "subject_kind": "artifact",
            "actor_id": "human_ceo",
            "created_at": "2026-02-10T12:00:00Z"
          }
        ]
      },
      "monitor": {
        "rows": [
          {
            "run_id": "run_1",
            "run_status": "running",
            "provider": "codex",
            "created_at": "2026-02-10T11:00:00Z",
            "last_event": {
              "type": "run.progress",
              "ts_wallclock": "2026-02-10T13:00:00Z"
            }
          }
        ]
      }
    }
    """#

    let value = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
    let items = RPCHelpers.parseActivityItems(value)

    XCTAssertEqual(items.count, 3)
    XCTAssertEqual(items.first?.id, "run-run_1")
    XCTAssertTrue(items[0].timestamp >= items[1].timestamp)
    XCTAssertTrue(items[1].timestamp >= items[2].timestamp)
  }
}
