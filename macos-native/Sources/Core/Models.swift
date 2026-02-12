import Foundation

public struct ProjectSummary: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let pendingReviews: Int
  public let activeRuns: Int
  public let taskCount: Int
  public let progressPct: Int
  public let blockedTasks: Int
  public let riskFlags: [String]

  public init(object: JSONObject) {
    self.id = object.string("project_id")
    self.name = object.string("name", default: id)
    self.pendingReviews = object.int("pending_reviews") ?? 0
    self.activeRuns = object.int("active_runs") ?? 0
    self.taskCount = object.int("task_count") ?? 0
    self.progressPct = object.int("progress_pct") ?? 0
    self.blockedTasks = object.int("blocked_tasks") ?? 0
    self.riskFlags = (object.array("risk_flags") ?? []).compactMap(\.stringValue)
  }
}

public struct AgentSummary: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let role: String
  public let provider: String
  public let modelHint: String

  public init(object: JSONObject) {
    self.id = object.string("agent_id")
    self.name = object.string("name", default: id)
    self.role = object.string("role", default: "worker")
    self.provider = object.string("provider", default: "manual")
    self.modelHint = object.string("model_hint")
  }
}

public struct TeamSummary: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String

  public init(object: JSONObject) {
    let preferredID = object.string("team_id")
    self.id = preferredID.isEmpty ? object.string("id") : preferredID
    let preferredName = object.string("name")
    self.name = preferredName.isEmpty ? id : preferredName
  }
}

public enum ConversationKind: String, Sendable {
  case channel
  case dm
  case unknown
}

public struct ConversationSummary: Identifiable, Equatable, Sendable {
  public let id: String
  public let kind: ConversationKind
  public let name: String
  public let slug: String
  public let scope: String
  public let dmPeerAgentID: String
  public let participantAgentIDs: [String]
  public let participantTeamIDs: [String]

  public init(object: JSONObject) {
    self.id = object.string("id")
    self.kind = ConversationKind(rawValue: object.string("kind")) ?? .unknown
    self.name = object.string("name", default: id)
    let rawSlug = object.string("slug")
    self.slug = rawSlug.isEmpty ? name : rawSlug
    self.scope = object.string("scope", default: "workspace")
    self.dmPeerAgentID = object.string("dm_peer_agent_id")

    let participants = object.object("participants")
    self.participantAgentIDs = (participants?.array("agent_ids") ?? []).compactMap(\.stringValue)
    self.participantTeamIDs = (participants?.array("team_ids") ?? []).compactMap(\.stringValue)
  }

  public var displayTitle: String {
    switch kind {
    case .channel:
      return "#\(slug)"
    case .dm:
      if !dmPeerAgentID.isEmpty {
        return "@\(dmPeerAgentID)"
      }
      return "@\(name)"
    case .unknown:
      return name
    }
  }
}

public struct ConversationMessage: Identifiable, Equatable, Sendable {
  public let id: String
  public let authorID: String
  public let body: String
  public let createdAt: String
  public let kind: String

  public init(object: JSONObject) {
    self.id = object.string("id")
    self.authorID = object.string("author_id")
    self.body = object.string("body")
    self.createdAt = object.string("created_at")
    self.kind = object.string("kind", default: "message")
  }
}

public struct ResourceSnapshot: Equatable, Sendable {
  public let totals: ResourceTotals
  public let providers: [ProviderUsage]
  public let models: [ModelUsage]

  public init(object: JSONObject) {
    self.totals = ResourceTotals(object: object.object("totals") ?? [:])
    self.providers = (object.array("providers") ?? []).compactMap { $0.objectValue }.map(ProviderUsage.init(object:))
    self.models = (object.array("models") ?? []).compactMap { $0.objectValue }.map(ModelUsage.init(object:))
  }

  public static let empty = ResourceSnapshot(object: [:])
}

public struct ResourceTotals: Equatable, Sendable {
  public let agents: Int
  public let workers: Int
  public let activeWorkers: Int
  public let runsIndexed: Int
  public let totalTokens: Int
  public let totalCostUSD: Double
  public let contextCyclesTotal: Int
  public let contextCyclesUnknownRuns: Int

  public init(object: JSONObject) {
    self.agents = object.int("agents") ?? 0
    self.workers = object.int("workers") ?? 0
    self.activeWorkers = object.int("active_workers") ?? 0
    self.runsIndexed = object.int("runs_indexed") ?? 0
    self.totalTokens = object.int("total_tokens") ?? 0
    self.totalCostUSD = object.double("total_cost_usd") ?? 0
    self.contextCyclesTotal = object.int("context_cycles_total") ?? 0
    self.contextCyclesUnknownRuns = object.int("context_cycles_unknown_runs") ?? 0
  }
}

public struct ProviderUsage: Equatable, Sendable {
  public let provider: String
  public let runCount: Int
  public let totalTokens: Int
  public let totalCostUSD: Double

  public init(object: JSONObject) {
    self.provider = object.string("provider", default: "unknown")
    self.runCount = object.int("run_count") ?? 0
    self.totalTokens = object.int("total_tokens") ?? 0
    self.totalCostUSD = object.double("total_cost_usd") ?? 0
  }
}

public struct ModelUsage: Equatable, Sendable {
  public let model: String
  public let agentCount: Int

  public init(object: JSONObject) {
    self.model = object.string("model", default: "unknown")
    self.agentCount = object.int("agent_count") ?? 0
  }
}

public struct PMSnapshot: Equatable, Sendable {
  public let workspace: PMWorkspaceBlock
  public let project: PMProjectBlock?

  public init(object: JSONObject) {
    self.workspace = PMWorkspaceBlock(object: object.object("workspace") ?? [:])
    if let projectObject = object.object("project") {
      self.project = PMProjectBlock(object: projectObject)
    } else {
      self.project = nil
    }
  }

  public static let empty = PMSnapshot(object: [:])
}

public struct PMWorkspaceBlock: Equatable, Sendable {
  public let summary: PMWorkspaceSummary
  public let projects: [PMProjectRow]

  public init(object: JSONObject) {
    self.summary = PMWorkspaceSummary(object: object.object("summary") ?? [:])
    self.projects = (object.array("projects") ?? []).compactMap { $0.objectValue }.map(PMProjectRow.init(object:))
  }
}

public struct PMWorkspaceSummary: Equatable, Sendable {
  public let projectCount: Int
  public let progressPct: Int
  public let blockedProjects: Int
  public let pendingReviews: Int
  public let activeRuns: Int

  public init(object: JSONObject) {
    self.projectCount = object.int("project_count") ?? 0
    self.progressPct = object.int("progress_pct") ?? 0
    self.blockedProjects = object.int("blocked_projects") ?? 0
    self.pendingReviews = object.int("pending_reviews") ?? 0
    self.activeRuns = object.int("active_runs") ?? 0
  }
}

public struct PMProjectRow: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let taskCount: Int
  public let progressPct: Int
  public let blockedTasks: Int
  public let activeRuns: Int
  public let riskFlags: [String]

  public init(object: JSONObject) {
    self.id = object.string("project_id")
    self.name = object.string("name", default: id)
    self.taskCount = object.int("task_count") ?? 0
    self.progressPct = object.int("progress_pct") ?? 0
    self.blockedTasks = object.int("blocked_tasks") ?? 0
    self.activeRuns = object.int("active_runs") ?? 0
    self.riskFlags = (object.array("risk_flags") ?? []).compactMap(\.stringValue)
  }
}

public struct PMProjectBlock: Equatable, Sendable {
  public let summary: PMProjectSummary
  public let gantt: PMGantt

  public init(object: JSONObject) {
    self.summary = PMProjectSummary(object: object.object("summary") ?? [:])
    self.gantt = PMGantt(object: object.object("gantt") ?? [:])
  }
}

public struct PMProjectSummary: Equatable, Sendable {
  public let taskCount: Int
  public let doneTasks: Int
  public let blockedTasks: Int
  public let inProgressTasks: Int
  public let progressPct: Int

  public init(object: JSONObject) {
    self.taskCount = object.int("task_count") ?? 0
    self.doneTasks = object.int("done_tasks") ?? 0
    self.blockedTasks = object.int("blocked_tasks") ?? 0
    self.inProgressTasks = object.int("in_progress_tasks") ?? 0
    self.progressPct = object.int("progress_pct") ?? 0
  }
}

public struct PMGantt: Equatable, Sendable {
  public let cpmStatus: String
  public let tasks: [PMGanttTask]

  public init(object: JSONObject) {
    self.cpmStatus = object.string("cpm_status", default: "ok")
    self.tasks = (object.array("tasks") ?? []).compactMap { $0.objectValue }.map(PMGanttTask.init(object:))
  }
}

public struct PMGanttTask: Identifiable, Equatable, Sendable {
  public let id: String
  public let title: String
  public let status: String
  public let progressPct: Int
  public let startAt: String
  public let endAt: String
  public let durationDays: Int
  public let critical: Bool

  public init(object: JSONObject) {
    self.id = object.string("task_id")
    self.title = object.string("title", default: id)
    self.status = object.string("status", default: "todo")
    self.progressPct = object.int("progress_pct") ?? 0
    self.startAt = object.string("start_at")
    self.endAt = object.string("end_at")
    self.durationDays = object.int("duration_days") ?? 0
    self.critical = object.bool("critical") ?? false
  }
}

public struct AllocationRecommendation: Identifiable, Equatable, Sendable {
  public let id: String
  public let taskID: String
  public let preferredProvider: String
  public let preferredModel: String
  public let preferredAgentID: String
  public let tokenBudgetHint: Int
  public let reason: String

  public init(object: JSONObject) {
    self.taskID = object.string("task_id")
    self.id = taskID
    self.preferredProvider = object.string("preferred_provider")
    self.preferredModel = object.string("preferred_model")
    self.preferredAgentID = object.string("preferred_agent_id")
    self.tokenBudgetHint = object.int("token_budget_hint") ?? 0
    self.reason = object.string("reason")
  }
}

public struct ActivityItem: Identifiable, Equatable, Sendable {
  public let id: String
  public let title: String
  public let body: String
  public let timestamp: String

  public init(id: String, title: String, body: String, timestamp: String) {
    self.id = id
    self.title = title
    self.body = body
    self.timestamp = timestamp
  }
}

public enum RPCHelpers {
  public static func object(_ value: JSONValue) -> JSONObject {
    value.objectValue ?? [:]
  }

  public static func array(_ value: JSONValue) -> [JSONValue] {
    value.arrayValue ?? []
  }

  public static func parseProjects(_ value: JSONValue) -> [ProjectSummary] {
    let payload = object(value)
    let rows = payload.array("projects") ?? []
    return rows.compactMap(\.objectValue).map(ProjectSummary.init(object:))
  }

  public static func parseAgents(_ value: JSONValue) -> [AgentSummary] {
    array(value).compactMap(\.objectValue).map(AgentSummary.init(object:))
  }

  public static func parseTeams(_ value: JSONValue) -> [TeamSummary] {
    array(value).compactMap(\.objectValue).map(TeamSummary.init(object:))
  }

  public static func parseConversations(_ value: JSONValue) -> [ConversationSummary] {
    array(value).compactMap(\.objectValue).map(ConversationSummary.init(object:))
  }

  public static func parseMessages(_ value: JSONValue) -> [ConversationMessage] {
    array(value).compactMap(\.objectValue).map(ConversationMessage.init(object:))
  }

  public static func parseResources(_ value: JSONValue) -> ResourceSnapshot {
    ResourceSnapshot(object: object(value))
  }

  public static func parsePM(_ value: JSONValue) -> PMSnapshot {
    PMSnapshot(object: object(value))
  }

  public static func parseRecommendations(_ value: JSONValue) -> [AllocationRecommendation] {
    let payload = object(value)
    let rows = payload.array("recommendations") ?? []
    return rows.compactMap(\.objectValue).map(AllocationRecommendation.init(object:))
  }

  public static func parseActivityItems(_ value: JSONValue) -> [ActivityItem] {
    let payload = object(value)
    let pending = payload.object("review_inbox")?.array("pending") ?? []
    let decisions = payload.object("review_inbox")?.array("recent_decisions") ?? []
    let runs = payload.object("monitor")?.array("rows") ?? []

    var items: [ActivityItem] = []

    for row in pending.compactMap(\.objectValue) {
      let id = row.string("artifact_id", default: UUID().uuidString)
      let title = "Pending approval: \(row.string("artifact_type", default: "artifact")) \(row.string("artifact_id"))"
      let body = "\(row.string("title", default: "Untitled")) · by \(row.string("produced_by", default: "unknown"))"
      items.append(ActivityItem(id: "pending-\(id)", title: title, body: body, timestamp: row.string("created_at")))
    }

    for row in decisions.compactMap(\.objectValue) {
      let id = row.string("subject_artifact_id", default: UUID().uuidString)
      let title = "\(row.string("decision").uppercased()) \(row.string("subject_kind", default: "item"))"
      let body = "\(row.string("subject_artifact_id")) · actor=\(row.string("actor_id", default: "unknown"))"
      items.append(ActivityItem(id: "decision-\(id)", title: title, body: body, timestamp: row.string("created_at")))
    }

    for row in runs.compactMap(\.objectValue) {
      let id = row.string("run_id", default: UUID().uuidString)
      let status = row.string("run_status")
      let provider = row.string("provider", default: "unknown")
      let event = row.object("last_event")?.string("type", default: "no events") ?? "no events"
      let body = "\(provider) · \(event)"
      let ts = row.object("last_event")?.string("ts_wallclock") ?? row.string("created_at")
      items.append(ActivityItem(id: "run-\(id)", title: "Run \(id) (\(status))", body: body, timestamp: ts))
    }

    return items.sorted { lhs, rhs in
      lhs.timestamp > rhs.timestamp
    }
  }
}
