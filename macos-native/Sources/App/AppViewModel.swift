import Foundation
import SwiftUI
import AgentCompanyNativeCore

@MainActor
final class AppViewModel: ObservableObject {
  enum ScopeSelection: Equatable {
    case workspace
    case project(String)

    var projectID: String? {
      if case .project(let id) = self { return id }
      return nil
    }

    var scopeValue: String {
      switch self {
      case .workspace:
        return "workspace"
      case .project:
        return "project"
      }
    }
  }

  enum ContentSelection: Equatable {
    case home
    case activities
    case resources
    case conversation(String)

    var conversationID: String? {
      if case .conversation(let id) = self { return id }
      return nil
    }
  }

  @Published var workspaceDir: String
  @Published var cliPath: String
  @Published var nodeBin: String
  @Published var actorID: String

  @Published var projects: [ProjectSummary] = []
  @Published var agents: [AgentSummary] = []
  @Published var teams: [TeamSummary] = []
  @Published var conversationsWorkspace: [ConversationSummary] = []
  @Published var conversationsProject: [ConversationSummary] = []
  @Published var selectedScope: ScopeSelection = .workspace
  @Published var selectedContent: ContentSelection = .home

  @Published var pmSnapshot: PMSnapshot = .empty
  @Published var resources: ResourceSnapshot = .empty
  @Published var activities: [ActivityItem] = []
  @Published var messages: [ConversationMessage] = []
  @Published var allocationRecommendations: [AllocationRecommendation] = []

  @Published var isRefreshing = false
  @Published var errorMessage = ""
  @Published var statusMessage = ""
  @Published var draftMessage = ""

  private let defaults = UserDefaults.standard

  private enum DefaultsKey {
    static let workspaceDir = "native.workspace_dir"
    static let cliPath = "native.cli_path"
    static let nodeBin = "native.node_bin"
    static let actorID = "native.actor_id"
  }

  init() {
    let defaultWorkspace = FileManager.default.currentDirectoryPath + "/work"
    self.workspaceDir = defaults.string(forKey: DefaultsKey.workspaceDir) ?? defaultWorkspace
    self.cliPath = defaults.string(forKey: DefaultsKey.cliPath) ?? AppViewModel.defaultCLIPath()
    self.nodeBin = defaults.string(forKey: DefaultsKey.nodeBin) ?? "node"
    self.actorID = defaults.string(forKey: DefaultsKey.actorID) ?? "human_ceo"
  }

  var currentConversations: [ConversationSummary] {
    selectedScope.projectID == nil ? conversationsWorkspace : conversationsProject
  }

  var selectedConversation: ConversationSummary? {
    guard case .conversation(let id) = selectedContent else { return nil }
    return currentConversations.first(where: { $0.id == id })
  }

  var selectedProject: ProjectSummary? {
    guard let projectID = selectedScope.projectID else { return nil }
    return projects.first(where: { $0.id == projectID })
  }

  func refreshAll() async {
    guard validateSettings() else { return }
    isRefreshing = true
    defer { isRefreshing = false }
    do {
      async let projectsValue = rpc(method: "workspace.projects.list", params: ["workspace_dir": .string(workspaceDir)])
      async let agentsValue = rpc(method: "workspace.agents.list", params: ["workspace_dir": .string(workspaceDir)])
      async let teamsValue = rpc(method: "workspace.teams.list", params: ["workspace_dir": .string(workspaceDir)])

      projects = RPCHelpers.parseProjects(try await projectsValue)
      agents = RPCHelpers.parseAgents(try await agentsValue)
      teams = RPCHelpers.parseTeams(try await teamsValue)

      if case .project(let projectID) = selectedScope,
         !projects.contains(where: { $0.id == projectID }) {
        selectedScope = .workspace
        selectedContent = .home
      }

      try await refreshConversations()
      await refreshCurrentViewData()
      persistSettings()
      errorMessage = ""
      statusMessage = "Last refresh: \(Self.refreshTimestamp(Date()))"
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func refreshCurrentViewData() async {
    guard validateSettings() else { return }

    do {
      switch selectedContent {
      case .home:
        let pm = try await rpc(method: "pm.snapshot", params: pmParams())
        pmSnapshot = RPCHelpers.parsePM(pm)
        let resourcesValue = try await rpc(method: "resources.snapshot", params: resourcesParams())
        resources = RPCHelpers.parseResources(resourcesValue)
        activities = []
        messages = []
        allocationRecommendations = []
        if let projectID = selectedScope.projectID {
          let recs = try await rpc(
            method: "pm.recommend_allocations",
            params: [
              "workspace_dir": .string(workspaceDir),
              "project_id": .string(projectID)
            ]
          )
          allocationRecommendations = RPCHelpers.parseRecommendations(recs)
        }
      case .activities:
        let value = try await rpc(method: "ui.snapshot", params: activitiesParams())
        activities = RPCHelpers.parseActivityItems(value)
        messages = []
        allocationRecommendations = []
      case .resources:
        let value = try await rpc(method: "resources.snapshot", params: resourcesParams())
        resources = RPCHelpers.parseResources(value)
        activities = []
        messages = []
        allocationRecommendations = []
      case .conversation(let conversationID):
        let value = try await rpc(method: "conversation.messages.list", params: messageListParams(conversationID: conversationID))
        messages = RPCHelpers.parseMessages(value)
        activities = []
        allocationRecommendations = []
      }
      errorMessage = ""
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func selectWorkspace() {
    selectedScope = .workspace
    selectedContent = .home
    Task { await refreshAll() }
  }

  func selectProject(_ projectID: String) {
    selectedScope = .project(projectID)
    selectedContent = .home
    Task { await refreshAll() }
  }

  func openHome() {
    selectedContent = .home
    Task { await refreshCurrentViewData() }
  }

  func openActivities() {
    selectedContent = .activities
    Task { await refreshCurrentViewData() }
  }

  func openResources() {
    selectedContent = .resources
    Task { await refreshCurrentViewData() }
  }

  func openConversation(_ conversationID: String) {
    selectedContent = .conversation(conversationID)
    Task { await refreshCurrentViewData() }
  }

  func sendMessage() async {
    guard let conversation = selectedConversation else { return }
    let trimmed = draftMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return }

    var params = baseScopeParams()
    params["workspace_dir"] = .string(workspaceDir)
    params["conversation_id"] = .string(conversation.id)
    params["author_id"] = .string(actorID)
    params["author_role"] = .string("ceo")
    params["body"] = .string(trimmed)

    do {
      _ = try await rpc(method: "conversation.message.send", params: params)
      draftMessage = ""
      await refreshCurrentViewData()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func createProject(name: String, repoIDs: [String]) async throws {
    var params: JSONObject = [
      "workspace_dir": .string(workspaceDir),
      "name": .string(name)
    ]
    if !repoIDs.isEmpty {
      params["repo_ids"] = .array(repoIDs.map(JSONValue.string))
    }

    let created = try await rpc(method: "workspace.project.create_with_defaults", params: params)
    let createdProjectID = RPCHelpers.object(created).string("project_id")
    if createdProjectID.isEmpty {
      await refreshAll()
      return
    }
    selectedScope = .project(createdProjectID)
    selectedContent = .home
    await refreshAll()
  }

  func createChannel(name: String, visibility: String, teamID: String?, participantIDs: [String]) async throws {
    var params = baseScopeParams()
    params["workspace_dir"] = .string(workspaceDir)
    params["name"] = .string(name)
    params["slug"] = .string(Self.slug(name))
    params["visibility"] = .string(visibility)
    params["created_by"] = .string(actorID)

    if let teamID, !teamID.isEmpty {
      params["team_ids"] = .array([.string(teamID)])
    }

    if !participantIDs.isEmpty {
      params["agent_ids"] = .array(participantIDs.map(JSONValue.string))
    }

    _ = try await rpc(method: "conversation.create_channel", params: params)
    try await refreshConversations()
  }

  func createDM(peerAgentID: String) async throws -> String {
    var params = baseScopeParams()
    params["workspace_dir"] = .string(workspaceDir)
    params["created_by"] = .string(actorID)
    params["peer_agent_id"] = .string(peerAgentID)

    let dm = try await rpc(method: "conversation.create_dm", params: params)
    let id = RPCHelpers.object(dm).string("id")
    try await refreshConversations()
    if id.isEmpty { return "" }
    selectedContent = .conversation(id)
    await refreshCurrentViewData()
    return id
  }

  func applyAllocations(_ items: [AllocationRecommendation]) async {
    guard let projectID = selectedScope.projectID else { return }
    let payload: [JSONValue] = items.map { item in
      .object([
        "task_id": .string(item.taskID),
        "preferred_provider": .string(item.preferredProvider),
        "preferred_model": .string(item.preferredModel),
        "preferred_agent_id": .string(item.preferredAgentID),
        "token_budget_hint": .number(Double(item.tokenBudgetHint))
      ])
    }

    if payload.isEmpty { return }

    do {
      _ = try await rpc(
        method: "pm.apply_allocations",
        params: [
          "workspace_dir": .string(workspaceDir),
          "project_id": .string(projectID),
          "applied_by": .string(actorID),
          "items": .array(payload)
        ]
      )
      await refreshCurrentViewData()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func saveConnection(workspaceDir: String, cliPath: String, nodeBin: String, actorID: String) {
    self.workspaceDir = workspaceDir
    self.cliPath = cliPath
    self.nodeBin = nodeBin
    self.actorID = actorID
    persistSettings()
  }

  func agentName(for agentID: String) -> String {
    if agentID == actorID || agentID == "human_ceo" { return "You" }
    return agents.first(where: { $0.id == agentID })?.name ?? agentID
  }

  func agentRole(for agentID: String) -> String {
    agents.first(where: { $0.id == agentID })?.role ?? "participant"
  }

  func agentProvider(for agentID: String) -> String {
    agents.first(where: { $0.id == agentID })?.provider ?? "manual"
  }

  private func client() -> LocalCLIClient {
    LocalCLIClient(
      environment: RPCEnvironment(
        nodeBin: nodeBin,
        cliPath: cliPath,
        workingDirectory: Self.resolveWorkingDirectory(from: cliPath)
      )
    )
  }

  private func rpc(method: String, params: JSONObject) async throws -> JSONValue {
    try await client().call(method: method, params: params)
  }

  private func refreshConversations() async throws {
    let workspace = try await rpc(
      method: "conversation.list",
      params: [
        "workspace_dir": .string(workspaceDir),
        "scope": .string("workspace")
      ]
    )
    conversationsWorkspace = RPCHelpers.parseConversations(workspace)

    if let projectID = selectedScope.projectID {
      let project = try await rpc(
        method: "conversation.list",
        params: [
          "workspace_dir": .string(workspaceDir),
          "scope": .string("project"),
          "project_id": .string(projectID)
        ]
      )
      conversationsProject = RPCHelpers.parseConversations(project)
    } else {
      conversationsProject = []
    }

    if case .conversation(let id) = selectedContent,
       !currentConversations.contains(where: { $0.id == id }) {
      selectedContent = .home
    }
  }

  private func pmParams() -> JSONObject {
    var params = baseScopeParams()
    params["workspace_dir"] = .string(workspaceDir)
    return params
  }

  private func resourcesParams() -> JSONObject {
    var params: JSONObject = ["workspace_dir": .string(workspaceDir)]
    if let projectID = selectedScope.projectID {
      params["project_id"] = .string(projectID)
    }
    return params
  }

  private func activitiesParams() -> JSONObject {
    var params: JSONObject = [
      "workspace_dir": .string(workspaceDir),
      "monitor_limit": .number(200),
      "pending_limit": .number(200),
      "decisions_limit": .number(200),
      "sync_index": .bool(true)
    ]
    if let projectID = selectedScope.projectID {
      params["project_id"] = .string(projectID)
    }
    return params
  }

  private func messageListParams(conversationID: String) -> JSONObject {
    var params = baseScopeParams()
    params["workspace_dir"] = .string(workspaceDir)
    params["conversation_id"] = .string(conversationID)
    params["limit"] = .number(300)
    return params
  }

  private func baseScopeParams() -> JSONObject {
    var params: JSONObject = [
      "scope": .string(selectedScope.scopeValue)
    ]
    if let projectID = selectedScope.projectID {
      params["project_id"] = .string(projectID)
    }
    return params
  }

  private func validateSettings() -> Bool {
    let trimmedWorkspace = workspaceDir.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedCLI = cliPath.trimmingCharacters(in: .whitespacesAndNewlines)

    if trimmedWorkspace.isEmpty {
      errorMessage = "Workspace directory is required."
      return false
    }

    if trimmedCLI.isEmpty {
      errorMessage = "CLI path is required (point it to dist/cli.js)."
      return false
    }

    return true
  }

  private func persistSettings() {
    defaults.set(workspaceDir, forKey: DefaultsKey.workspaceDir)
    defaults.set(cliPath, forKey: DefaultsKey.cliPath)
    defaults.set(nodeBin, forKey: DefaultsKey.nodeBin)
    defaults.set(actorID, forKey: DefaultsKey.actorID)
  }

  private static func defaultCLIPath() -> String {
    let current = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    for candidate in current.ancestors(maxDepth: 6) {
      let cli = candidate.appendingPathComponent("dist/cli.js")
      if FileManager.default.fileExists(atPath: cli.path) {
        return cli.path
      }
    }
    return current.appendingPathComponent("dist/cli.js").path
  }

  private static func resolveWorkingDirectory(from cliPath: String) -> String {
    let cliURL = URL(fileURLWithPath: cliPath)
    let distDirectory = cliURL.deletingLastPathComponent()
    let rootDirectory = distDirectory.deletingLastPathComponent()
    if FileManager.default.fileExists(atPath: rootDirectory.path) {
      return rootDirectory.path
    }
    return FileManager.default.currentDirectoryPath
  }

  private static func slug(_ text: String) -> String {
    let lowered = text.lowercased()
    let replaced = lowered.replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
    return replaced.trimmingCharacters(in: CharacterSet(charactersIn: "-")).prefix(64).description
  }

  private static func refreshTimestamp(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateStyle = .none
    formatter.timeStyle = .short
    return formatter.string(from: date)
  }
}

private extension URL {
  func ancestors(maxDepth: Int) -> [URL] {
    var urls: [URL] = [self]
    var current = self
    for _ in 0..<maxDepth {
      let parent = current.deletingLastPathComponent()
      if parent.path == current.path { break }
      urls.append(parent)
      current = parent
    }
    return urls
  }
}
