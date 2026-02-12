import SwiftUI
import AgentCompanyNativeCore

struct MainView: View {
  @EnvironmentObject private var model: AppViewModel

  @State private var showSettings = false
  @State private var showCreateProject = false
  @State private var showCreateChannel = false
  @State private var showCreateDM = false

  var body: some View {
    HSplitView {
      ProjectRailView(
        projects: model.projects,
        selectedScope: model.selectedScope,
        onSelectWorkspace: model.selectWorkspace,
        onSelectProject: model.selectProject,
        onCreateProject: { showCreateProject = true },
        onOpenSettings: { showSettings = true }
      )
      .frame(minWidth: 84, idealWidth: 88, maxWidth: 96)

      ContextSidebarView(
        model: model,
        onCreateChannel: { showCreateChannel = true },
        onCreateDM: { showCreateDM = true }
      )
      .frame(minWidth: 240, idealWidth: 272, maxWidth: 320)

      ContentView(model: model)
        .frame(minWidth: 680)

      DetailsPane(model: model)
        .frame(minWidth: 230, idealWidth: 280, maxWidth: 320)
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .toolbar {
      ToolbarItem(placement: .principal) {
        VStack(alignment: .leading, spacing: 2) {
          Text(headerTitle)
            .font(.headline)
          Text(headerSubtitle)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      ToolbarItemGroup {
        Button {
          Task { await model.refreshAll() }
        } label: {
          Label("Refresh", systemImage: "arrow.clockwise")
        }
        .help("Refresh workspace")

        Button {
          showSettings = true
        } label: {
          Label("Settings", systemImage: "gearshape")
        }
        .help("Open settings")
      }
    }
    .sheet(isPresented: $showSettings) {
      SettingsSheet(
        initialWorkspaceDir: model.workspaceDir,
        initialCLIPath: model.cliPath,
        initialNodeBin: model.nodeBin,
        initialActorID: model.actorID,
        onSave: { workspaceDir, cliPath, nodeBin, actorID in
          model.saveConnection(
            workspaceDir: workspaceDir,
            cliPath: cliPath,
            nodeBin: nodeBin,
            actorID: actorID
          )
          Task { await model.refreshAll() }
        }
      )
      .frame(minWidth: 620, minHeight: 340)
      .presentationDetents([.medium])
    }
    .sheet(isPresented: $showCreateProject) {
      CreateProjectSheet { name, repoIDs in
        try await model.createProject(name: name, repoIDs: repoIDs)
      }
      .frame(minWidth: 560, minHeight: 280)
      .presentationDetents([.height(320)])
    }
    .sheet(isPresented: $showCreateChannel) {
      CreateChannelSheet(model: model) { name, visibility, teamID, participantIDs in
        try await model.createChannel(
          name: name,
          visibility: visibility,
          teamID: teamID,
          participantIDs: participantIDs
        )
      }
      .frame(minWidth: 640, minHeight: 480)
      .presentationDetents([.large])
    }
    .sheet(isPresented: $showCreateDM) {
      CreateDMSheet(model: model) { peerAgentID in
        _ = try await model.createDM(peerAgentID: peerAgentID)
      }
      .frame(minWidth: 560, minHeight: 420)
      .presentationDetents([.medium, .large])
    }
    .overlay(alignment: .top) {
      if !model.errorMessage.isEmpty {
        Banner(message: model.errorMessage, kind: .error)
          .padding(.top, 8)
      } else if !model.statusMessage.isEmpty {
        Banner(message: model.statusMessage, kind: .info)
          .padding(.top, 8)
      }
    }
  }

  private var headerTitle: String {
    switch model.selectedScope {
    case .workspace:
      return "Workspace"
    case .project(let id):
      return model.projects.first(where: { $0.id == id })?.name ?? "Project"
    }
  }

  private var headerSubtitle: String {
    switch model.selectedContent {
    case .home:
      return model.selectedScope.projectID == nil
        ? "Portfolio command center"
        : "Project home, schedule, and allocation"
    case .activities:
      return "Operational activity feed"
    case .resources:
      return "Resource and usage analytics"
    case .conversation(let id):
      return model.currentConversations.first(where: { $0.id == id })?.displayTitle ?? "Conversation"
    }
  }
}

private struct ProjectRailView: View {
  let projects: [ProjectSummary]
  let selectedScope: AppViewModel.ScopeSelection
  let onSelectWorkspace: () -> Void
  let onSelectProject: (String) -> Void
  let onCreateProject: () -> Void
  let onOpenSettings: () -> Void

  var body: some View {
    VStack(spacing: 10) {
      Circle()
        .fill(.quaternary)
        .overlay {
          Text("AC")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
        }
        .frame(width: 38, height: 38)
        .padding(.top, 10)

      RailButton(
        title: "Home",
        subtitle: "Workspace",
        isActive: selectedScope.projectID == nil,
        badge: nil,
        action: onSelectWorkspace
      )

      ScrollView {
        VStack(spacing: 8) {
          ForEach(projects) { project in
            RailButton(
              title: shortLabel(for: project.name),
              subtitle: project.name,
              isActive: selectedScope.projectID == project.id,
              badge: project.pendingReviews > 0 ? project.pendingReviews : (project.activeRuns > 0 ? project.activeRuns : nil),
              action: { onSelectProject(project.id) }
            )
          }
        }
      }

      Button(action: onCreateProject) {
        Image(systemName: "plus")
          .font(.system(size: 14, weight: .semibold))
          .frame(width: 36, height: 36)
      }
      .buttonStyle(.bordered)
      .help("Add project")

      Spacer(minLength: 12)

      Button(action: onOpenSettings) {
        Image(systemName: "gearshape")
          .font(.system(size: 14, weight: .semibold))
          .frame(width: 36, height: 36)
      }
      .buttonStyle(.bordered)
      .padding(.bottom, 10)
      .help("Settings")
    }
    .padding(.horizontal, 8)
    .background(.bar)
  }

  private func shortLabel(for name: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "P" }
    let chunks = trimmed.split(separator: " ")
    if chunks.count >= 2 {
      let first = chunks[0].prefix(1)
      let second = chunks[1].prefix(1)
      return String(first + second).uppercased()
    }
    return String(trimmed.prefix(2)).uppercased()
  }
}

private struct RailButton: View {
  let title: String
  let subtitle: String
  let isActive: Bool
  let badge: Int?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 4) {
        ZStack(alignment: .topTrailing) {
          RoundedRectangle(cornerRadius: 11)
            .fill(isActive ? Color.accentColor.opacity(0.20) : Color.secondary.opacity(0.12))
            .frame(width: 52, height: 40)
            .overlay {
              Text(title)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(isActive ? Color.accentColor : Color.primary)
            }

          if let badge {
            Text("\(badge)")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(.white)
              .padding(.horizontal, 6)
              .padding(.vertical, 1)
              .background(.red, in: Capsule())
              .offset(x: 8, y: -8)
          }
        }
        Text(subtitle)
          .lineLimit(1)
          .font(.system(size: 10))
          .foregroundStyle(.secondary)
          .frame(maxWidth: 64)
      }
    }
    .buttonStyle(.plain)
  }
}

private struct ContextSidebarView: View {
  @ObservedObject var model: AppViewModel
  let onCreateChannel: () -> Void
  let onCreateDM: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(scopeTitle)
          .font(.title3.weight(.semibold))
        Text(scopeSubtitle)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 12)
      .padding(.top, 12)

      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          SidebarSection(title: "Home") {
            SidebarRow(
              title: "Home",
              systemImage: "house",
              isSelected: model.selectedContent == .home,
              action: model.openHome
            )
          }

          SidebarSection(title: "Channels", trailingButton: ("plus", onCreateChannel)) {
            let channels = model.currentConversations.filter { $0.kind == .channel }
            if channels.isEmpty {
              EmptySectionLabel("No channels")
            } else {
              ForEach(channels) { conversation in
                SidebarRow(
                  title: "#\(conversation.slug)",
                  systemImage: "number",
                  isSelected: model.selectedContent == .conversation(conversation.id),
                  action: { model.openConversation(conversation.id) }
                )
              }
            }
          }

          SidebarSection(title: "DMs", trailingButton: ("plus", onCreateDM)) {
            let dms = model.currentConversations.filter { $0.kind == .dm }
            if dms.isEmpty {
              EmptySectionLabel("No direct messages")
            } else {
              ForEach(dms) { conversation in
                SidebarRow(
                  title: dmTitle(conversation: conversation),
                  systemImage: "at",
                  isSelected: model.selectedContent == .conversation(conversation.id),
                  action: { model.openConversation(conversation.id) }
                )
              }
            }
          }

          SidebarSection(title: "Views") {
            SidebarRow(
              title: "Activities",
              systemImage: "waveform.path.ecg",
              isSelected: model.selectedContent == .activities,
              action: model.openActivities
            )
            SidebarRow(
              title: "Resources",
              systemImage: "chart.pie",
              isSelected: model.selectedContent == .resources,
              action: model.openResources
            )
          }
        }
        .padding(.horizontal, 10)
      }

      Spacer(minLength: 10)
    }
    .background(Color(nsColor: .controlBackgroundColor))
  }

  private var scopeTitle: String {
    if let project = model.selectedProject {
      return project.name
    }
    return "Workspace"
  }

  private var scopeSubtitle: String {
    model.selectedProject == nil
      ? "Portfolio + global channels"
      : "Project operations"
  }

  private func dmTitle(conversation: ConversationSummary) -> String {
    if !conversation.dmPeerAgentID.isEmpty {
      return "@\(model.agentName(for: conversation.dmPeerAgentID))"
    }
    return "@\(conversation.slug)"
  }
}

private struct SidebarSection<Content: View>: View {
  let title: String
  var trailingButton: (symbol: String, action: () -> Void)? = nil
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(title.uppercased())
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
        Spacer()
        if let trailingButton {
          Button(action: trailingButton.action) {
            Image(systemName: trailingButton.symbol)
              .font(.system(size: 11, weight: .semibold))
          }
          .buttonStyle(.borderless)
        }
      }
      content
    }
  }
}

private struct SidebarRow: View {
  let title: String
  let systemImage: String
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        Image(systemName: systemImage)
          .font(.system(size: 11, weight: .semibold))
          .frame(width: 16)
        Text(title)
          .lineLimit(1)
          .font(.system(size: 13, weight: .medium))
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 7)
      .background(isSelected ? Color.accentColor.opacity(0.16) : .clear, in: RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(.plain)
  }
}

private struct EmptySectionLabel: View {
  let text: String

  init(_ text: String) {
    self.text = text
  }

  var body: some View {
    Text(text)
      .font(.caption)
      .foregroundStyle(.secondary)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
  }
}

private struct ContentView: View {
  @ObservedObject var model: AppViewModel

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        switch model.selectedContent {
        case .home:
          if model.selectedScope.projectID == nil {
            WorkspaceHomeView(model: model)
          } else {
            ProjectHomeView(model: model)
          }
        case .activities:
          ActivitiesView(items: model.activities)
        case .resources:
          ResourcesView(snapshot: model.resources)
        case .conversation:
          ConversationTimelineView(model: model)
        }
      }

      if case .conversation = model.selectedContent {
        Divider()
        ComposerView(model: model)
      }
    }
    .background(.background)
  }
}

private struct WorkspaceHomeView: View {
  @ObservedObject var model: AppViewModel

  private let grid = [
    GridItem(.adaptive(minimum: 170), spacing: 10)
  ]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        LazyVGrid(columns: grid, spacing: 10) {
          MetricCard(title: "Projects", value: "\(model.pmSnapshot.workspace.summary.projectCount)")
          MetricCard(title: "Progress", value: "\(model.pmSnapshot.workspace.summary.progressPct)%")
          MetricCard(title: "Blocked", value: "\(model.pmSnapshot.workspace.summary.blockedProjects)")
          MetricCard(title: "Pending Reviews", value: "\(model.pmSnapshot.workspace.summary.pendingReviews)")
          MetricCard(title: "Active Runs", value: "\(model.pmSnapshot.workspace.summary.activeRuns)")
          MetricCard(title: "Tokens", value: NumberFormatter.grouped.string(from: NSNumber(value: model.resources.totals.totalTokens)) ?? "0")
          MetricCard(title: "Cost (USD)", value: NumberFormatter.usd4.string(from: NSNumber(value: model.resources.totals.totalCostUSD)) ?? "$0.0000")
          MetricCard(title: "Active Workers", value: "\(model.resources.totals.activeWorkers)")
        }

        GroupBox {
          VStack(spacing: 0) {
            HStack {
              Text("Project")
                .font(.caption.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
              Text("Tasks")
                .font(.caption.weight(.semibold))
                .frame(width: 60, alignment: .trailing)
              Text("Progress")
                .font(.caption.weight(.semibold))
                .frame(width: 84, alignment: .trailing)
              Text("Blocked")
                .font(.caption.weight(.semibold))
                .frame(width: 74, alignment: .trailing)
              Text("Runs")
                .font(.caption.weight(.semibold))
                .frame(width: 64, alignment: .trailing)
            }
            .foregroundStyle(.secondary)
            .padding(.vertical, 6)

            Divider()

            if model.pmSnapshot.workspace.projects.isEmpty {
              Text("No projects yet.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 18)
            } else {
              ForEach(model.pmSnapshot.workspace.projects) { row in
                HStack {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(row.name)
                      .font(.subheadline.weight(.medium))
                    if !row.riskFlags.isEmpty {
                      Text(row.riskFlags.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.orange)
                    }
                  }
                  .frame(maxWidth: .infinity, alignment: .leading)
                  Text("\(row.taskCount)")
                    .frame(width: 60, alignment: .trailing)
                  Text("\(row.progressPct)%")
                    .frame(width: 84, alignment: .trailing)
                  Text("\(row.blockedTasks)")
                    .frame(width: 74, alignment: .trailing)
                  Text("\(row.activeRuns)")
                    .frame(width: 64, alignment: .trailing)
                }
                .font(.subheadline)
                .padding(.vertical, 8)
                Divider()
              }
            }
          }
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
        } label: {
          Label("Portfolio Health", systemImage: "square.grid.3x3.topleft.filled")
            .font(.headline)
        }
      }
      .padding(14)
    }
  }
}

private struct ProjectHomeView: View {
  @ObservedObject var model: AppViewModel

  private let grid = [GridItem(.adaptive(minimum: 160), spacing: 10)]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        let summary = model.pmSnapshot.project?.summary
        LazyVGrid(columns: grid, spacing: 10) {
          MetricCard(title: "Tasks", value: "\(summary?.taskCount ?? 0)")
          MetricCard(title: "Progress", value: "\(summary?.progressPct ?? 0)%")
          MetricCard(title: "In Progress", value: "\(summary?.inProgressTasks ?? 0)")
          MetricCard(title: "Blocked", value: "\(summary?.blockedTasks ?? 0)")
          MetricCard(title: "Tokens", value: NumberFormatter.grouped.string(from: NSNumber(value: model.resources.totals.totalTokens)) ?? "0")
          MetricCard(title: "Cost (USD)", value: NumberFormatter.usd4.string(from: NSNumber(value: model.resources.totals.totalCostUSD)) ?? "$0.0000")
          MetricCard(title: "Cycles", value: "\(model.resources.totals.contextCyclesTotal)")
          MetricCard(title: "CPM", value: model.pmSnapshot.project?.gantt.cpmStatus ?? "ok")
        }

        GroupBox {
          GanttChartView(tasks: model.pmSnapshot.project?.gantt.tasks ?? [])
            .padding(.top, 6)
        } label: {
          Label("Gantt / Critical Path", systemImage: "timeline.selection")
            .font(.headline)
        }

        GroupBox {
          VStack(alignment: .leading, spacing: 10) {
            HStack {
              Text("Allocation Recommendations")
                .font(.headline)
              Spacer()
              Button("Apply All") {
                Task { await model.applyAllocations(model.allocationRecommendations) }
              }
              .buttonStyle(.borderedProminent)
              .disabled(model.allocationRecommendations.isEmpty)
            }

            if model.allocationRecommendations.isEmpty {
              Text("No recommendations available.")
                .foregroundStyle(.secondary)
            } else {
              ForEach(model.allocationRecommendations) { row in
                HStack(spacing: 8) {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(row.taskID)
                      .font(.subheadline.weight(.semibold))
                    Text(row.reason)
                      .font(.caption)
                      .foregroundStyle(.secondary)
                      .lineLimit(2)
                  }
                  Spacer()
                  Text("\(row.preferredProvider)/\(row.preferredModel)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                  Text(model.agentName(for: row.preferredAgentID))
                    .font(.subheadline)
                    .frame(minWidth: 130, alignment: .trailing)
                  Text("\(row.tokenBudgetHint)")
                    .font(.caption.monospacedDigit())
                    .frame(width: 70, alignment: .trailing)

                  Button("Apply") {
                    Task { await model.applyAllocations([row]) }
                  }
                  .buttonStyle(.bordered)
                }
                .padding(.vertical, 6)
                Divider()
              }
            }
          }
          .padding(.top, 4)
        }
      }
      .padding(14)
    }
  }
}

private struct MetricCard: View {
  let title: String
  let value: String

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(title.uppercased())
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.secondary)
      Text(value)
        .font(.title3.weight(.semibold))
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(11)
    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
  }
}

private struct GanttChartView: View {
  let tasks: [PMGanttTask]

  var body: some View {
    if tasks.isEmpty {
      Text("No scheduled tasks yet.")
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
    } else {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(tasks) { task in
          HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
              Text(task.title)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
              Text("\(task.status) · \(task.progressPct)%")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .frame(width: 190, alignment: .leading)

            GeometryReader { proxy in
              let metrics = barMetrics(task: task)
              ZStack(alignment: .leading) {
                Capsule()
                  .fill(Color.secondary.opacity(0.16))
                  .frame(height: 14)
                Capsule()
                  .fill(task.critical ? Color.red.opacity(0.7) : Color.accentColor.opacity(0.75))
                  .frame(width: max(10, proxy.size.width * metrics.width), height: 14)
                  .offset(x: proxy.size.width * metrics.start)
              }
            }
            .frame(height: 16)

            Text("\(task.durationDays)d")
              .font(.caption.monospacedDigit())
              .foregroundStyle(.secondary)
              .frame(width: 44, alignment: .trailing)
          }
          .frame(height: 28)
        }
      }
    }
  }

  private func barMetrics(task: PMGanttTask) -> (start: CGFloat, width: CGFloat) {
    let range = ganttRange(tasks: tasks)
    guard let startDate = ISO8601.parse(task.startAt),
          let endDate = ISO8601.parse(task.endAt) else {
      return (0, 0.15)
    }

    let total = max(1, range.max.timeIntervalSince(range.min))
    let start = max(0, startDate.timeIntervalSince(range.min) / total)
    let width = max(0.05, endDate.timeIntervalSince(startDate) / total)
    return (CGFloat(start), CGFloat(width))
  }

  private func ganttRange(tasks: [PMGanttTask]) -> (min: Date, max: Date) {
    var starts: [Date] = []
    var ends: [Date] = []

    for task in tasks {
      if let start = ISO8601.parse(task.startAt) {
        starts.append(start)
      }
      if let end = ISO8601.parse(task.endAt) {
        ends.append(end)
      }
    }

    let minDate = starts.min() ?? Date()
    let maxDate = ends.max() ?? minDate.addingTimeInterval(86_400)
    return (minDate, maxDate)
  }
}

private struct ActivitiesView: View {
  let items: [ActivityItem]

  var body: some View {
    if items.isEmpty {
      EmptyStateView(
        title: "No activities yet",
        subtitle: "Approvals, run telemetry, and decisions will appear here."
      )
    } else {
      List(items) { item in
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            Text(item.title)
              .font(.subheadline.weight(.semibold))
            Spacer()
            Text(item.timestamp.prettyTimestamp)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Text(item.body)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(3)
        }
        .padding(.vertical, 3)
      }
      .listStyle(.inset)
    }
  }
}

private struct ResourcesView: View {
  let snapshot: ResourceSnapshot

  private let grid = [GridItem(.adaptive(minimum: 170), spacing: 10)]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        LazyVGrid(columns: grid, spacing: 10) {
          MetricCard(title: "Agents", value: "\(snapshot.totals.agents)")
          MetricCard(title: "Workers", value: "\(snapshot.totals.workers)")
          MetricCard(title: "Active Workers", value: "\(snapshot.totals.activeWorkers)")
          MetricCard(title: "Runs Indexed", value: "\(snapshot.totals.runsIndexed)")
          MetricCard(title: "Tokens", value: NumberFormatter.grouped.string(from: NSNumber(value: snapshot.totals.totalTokens)) ?? "0")
          MetricCard(title: "Cost (USD)", value: NumberFormatter.usd4.string(from: NSNumber(value: snapshot.totals.totalCostUSD)) ?? "$0.0000")
          MetricCard(title: "Context Cycles", value: "\(snapshot.totals.contextCyclesTotal)")
          MetricCard(title: "Unknown Cycle Runs", value: "\(snapshot.totals.contextCyclesUnknownRuns)")
        }

        GroupBox {
          if snapshot.providers.isEmpty {
            Text("No provider usage data.")
              .foregroundStyle(.secondary)
          } else {
            VStack(spacing: 8) {
              ForEach(Array(snapshot.providers.enumerated()), id: \.offset) { _, provider in
                HStack {
                  Text(provider.provider)
                    .font(.subheadline.weight(.semibold))
                  Spacer()
                  Text("runs \(provider.runCount)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                  Text("tokens \(provider.totalTokens)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                  Text(NumberFormatter.usd4.string(from: NSNumber(value: provider.totalCostUSD)) ?? "$0.0000")
                    .font(.caption.monospacedDigit())
                }
              }
            }
          }
        } label: {
          Label("Providers", systemImage: "server.rack")
            .font(.headline)
        }

        GroupBox {
          if snapshot.models.isEmpty {
            Text("No model usage data.")
              .foregroundStyle(.secondary)
          } else {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(Array(snapshot.models.enumerated()), id: \.offset) { _, model in
                HStack {
                  Text(model.model)
                    .font(.subheadline)
                  Spacer()
                  Text("agents \(model.agentCount)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
              }
            }
          }
        } label: {
          Label("Models", systemImage: "cpu")
            .font(.headline)
        }
      }
      .padding(14)
    }
  }
}

private struct ConversationTimelineView: View {
  @ObservedObject var model: AppViewModel

  var body: some View {
    if let conversation = model.selectedConversation {
      VStack(spacing: 0) {
        HStack {
          Text(conversation.displayTitle)
            .font(.title3.weight(.semibold))
          Spacer()
          Text(model.messages.count == 1 ? "1 message" : "\(model.messages.count) messages")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)

        Divider()

        if model.messages.isEmpty {
          EmptyStateView(
            title: "No messages yet",
            subtitle: "Start the conversation to coordinate work."
          )
        } else {
          ScrollViewReader { proxy in
            ScrollView {
              LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(model.messages) { message in
                  MessageBubble(
                    author: model.agentName(for: message.authorID),
                    meta: "\(model.agentRole(for: message.authorID)) · \(message.createdAt.prettyTimestamp)",
                    messageBody: message.body,
                    isSelf: message.authorID == model.actorID || message.authorID == "human_ceo"
                  )
                  .id(message.id)
                }
              }
              .padding(14)
            }
            .onAppear {
              if let id = model.messages.last?.id {
                proxy.scrollTo(id, anchor: .bottom)
              }
            }
            .onChange(of: model.messages.last?.id) { _, newID in
              if let newID {
                withAnimation(.easeOut(duration: 0.18)) {
                  proxy.scrollTo(newID, anchor: .bottom)
                }
              }
            }
          }
        }
      }
    } else {
      EmptyStateView(
        title: "No conversation selected",
        subtitle: "Choose a channel or DM from the sidebar."
      )
    }
  }
}

private struct MessageBubble: View {
  let author: String
  let meta: String
  let messageBody: String
  let isSelf: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack {
        Text(author)
          .font(.subheadline.weight(.semibold))
        Text(meta)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Text(messageBody)
        .font(.body)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(10)
    .background(isSelf ? Color.accentColor.opacity(0.10) : Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
  }
}

private struct ComposerView: View {
  @ObservedObject var model: AppViewModel

  var body: some View {
    VStack(spacing: 8) {
      TextEditor(text: $model.draftMessage)
        .font(.body)
        .frame(minHeight: 68, maxHeight: 130)
        .overlay {
          RoundedRectangle(cornerRadius: 8)
            .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
        }

      HStack {
        Text("CEO can message channels and DMs directly")
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer()
        Button("Send") {
          Task { await model.sendMessage() }
        }
        .buttonStyle(.borderedProminent)
        .disabled(model.draftMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(12)
    .background(.bar)
  }
}

private struct DetailsPane: View {
  @ObservedObject var model: AppViewModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(detailsTitle)
        .font(.headline)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)

      Divider()

      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          if detailRows.isEmpty {
            Text("No participants.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .padding(.top, 12)
          } else {
            ForEach(detailRows, id: \.self) { agentID in
              Button {
                Task {
                  do {
                    _ = try await model.createDM(peerAgentID: agentID)
                  } catch {
                    model.errorMessage = error.localizedDescription
                  }
                }
              } label: {
                HStack(alignment: .center, spacing: 8) {
                  Circle()
                    .fill(Color.secondary.opacity(0.2))
                    .frame(width: 26, height: 26)
                    .overlay {
                      Text(String(model.agentName(for: agentID).prefix(1)).uppercased())
                        .font(.caption.weight(.semibold))
                    }

                  VStack(alignment: .leading, spacing: 2) {
                    Text(model.agentName(for: agentID))
                      .font(.subheadline.weight(.medium))
                    Text("\(model.agentRole(for: agentID)) · \(model.agentProvider(for: agentID))")
                      .font(.caption)
                      .foregroundStyle(.secondary)
                  }
                  Spacer()
                  Image(systemName: "message")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(8)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
              }
              .buttonStyle(.plain)
            }
          }
        }
        .padding(10)
      }
    }
    .background(Color(nsColor: .controlBackgroundColor))
  }

  private var detailsTitle: String {
    if case .conversation = model.selectedContent {
      return "Participants"
    }
    if case .home = model.selectedContent, model.selectedScope.projectID != nil {
      return "Recommended Agents"
    }
    return "People"
  }

  private var detailRows: [String] {
    if case .conversation = model.selectedContent,
       let selected = model.selectedConversation {
      return Array(Set(selected.participantAgentIDs)).filter { !$0.isEmpty }
    }

    if case .home = model.selectedContent,
       model.selectedScope.projectID != nil {
      let ids = model.allocationRecommendations.map(\.preferredAgentID).filter { !$0.isEmpty }
      return Array(Set(ids))
    }

    return model.agents.map(\.id)
  }
}

private struct EmptyStateView: View {
  let title: String
  let subtitle: String

  var body: some View {
    VStack(spacing: 6) {
      Text(title)
        .font(.title3.weight(.semibold))
      Text(subtitle)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 420)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(24)
  }
}

private struct SettingsSheet: View {
  @Environment(\.dismiss) private var dismiss

  @State private var workspaceDir: String
  @State private var cliPath: String
  @State private var nodeBin: String
  @State private var actorID: String

  let onSave: (String, String, String, String) -> Void

  init(
    initialWorkspaceDir: String,
    initialCLIPath: String,
    initialNodeBin: String,
    initialActorID: String,
    onSave: @escaping (String, String, String, String) -> Void
  ) {
    _workspaceDir = State(initialValue: initialWorkspaceDir)
    _cliPath = State(initialValue: initialCLIPath)
    _nodeBin = State(initialValue: initialNodeBin)
    _actorID = State(initialValue: initialActorID)
    self.onSave = onSave
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Connection Settings")
        .font(.title3.weight(.semibold))

      Form {
        TextField("Workspace directory", text: $workspaceDir)
        TextField("CLI path (dist/cli.js)", text: $cliPath)
        TextField("Node binary", text: $nodeBin)
        TextField("CEO actor id", text: $actorID)
      }
      .formStyle(.grouped)

      HStack {
        Spacer()
        Button("Cancel") { dismiss() }
        Button("Save") {
          onSave(
            workspaceDir.trimmingCharacters(in: .whitespacesAndNewlines),
            cliPath.trimmingCharacters(in: .whitespacesAndNewlines),
            nodeBin.trimmingCharacters(in: .whitespacesAndNewlines),
            actorID.trimmingCharacters(in: .whitespacesAndNewlines)
          )
          dismiss()
        }
        .buttonStyle(.borderedProminent)
      }
    }
    .padding(18)
  }
}

private struct CreateProjectSheet: View {
  @Environment(\.dismiss) private var dismiss

  @State private var name = ""
  @State private var repoIDsRaw = ""
  @State private var error = ""
  @State private var isBusy = false

  let onCreate: (String, [String]) async throws -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Create Project")
        .font(.title3.weight(.semibold))

      TextField("Project name", text: $name)
      TextField("Repo IDs (comma separated)", text: $repoIDsRaw)

      if !error.isEmpty {
        Text(error)
          .font(.caption)
          .foregroundStyle(.red)
      }

      HStack {
        Spacer()
        Button("Cancel") { dismiss() }
        Button(isBusy ? "Creating..." : "Create") {
          Task {
            await submit()
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(isBusy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(18)
  }

  private func submit() async {
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedName.isEmpty {
      error = "Project name is required."
      return
    }

    isBusy = true
    defer { isBusy = false }

    do {
      let repoIDs = repoIDsRaw
        .split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
      try await onCreate(trimmedName, repoIDs)
      dismiss()
    } catch {
      self.error = error.localizedDescription
    }
  }
}

private struct CreateChannelSheet: View {
  @Environment(\.dismiss) private var dismiss

  @ObservedObject var model: AppViewModel

  @State private var name = ""
  @State private var visibility = "team"
  @State private var selectedTeamID = ""
  @State private var participantIDs: Set<String> = []
  @State private var error = ""
  @State private var isBusy = false

  let onCreate: (String, String, String?, [String]) async throws -> Void

  private let visibilities = ["team", "managers", "org", "private_agent"]

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Create Channel")
        .font(.title3.weight(.semibold))

      Form {
        TextField("Channel name", text: $name)

        Picker("Visibility", selection: $visibility) {
          ForEach(visibilities, id: \.self) { value in
            Text(value).tag(value)
          }
        }

        Picker("Team", selection: $selectedTeamID) {
          Text("No team binding").tag("")
          ForEach(model.teams) { team in
            Text(team.name).tag(team.id)
          }
        }

        Section("Participants") {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
              ForEach(model.agents) { agent in
                Toggle(isOn: binding(for: agent.id)) {
                  VStack(alignment: .leading, spacing: 1) {
                    Text(agent.name)
                    Text("\(agent.role) · \(agent.provider)")
                      .font(.caption)
                      .foregroundStyle(.secondary)
                  }
                }
                .toggleStyle(.checkbox)
              }
            }
          }
          .frame(maxHeight: 200)
        }
      }
      .formStyle(.grouped)

      if !error.isEmpty {
        Text(error)
          .font(.caption)
          .foregroundStyle(.red)
      }

      HStack {
        Spacer()
        Button("Cancel") { dismiss() }
        Button(isBusy ? "Creating..." : "Create") {
          Task { await submit() }
        }
        .buttonStyle(.borderedProminent)
        .disabled(isBusy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(18)
    .onAppear {
      if participantIDs.isEmpty {
        participantIDs = Set(model.agents.map(\.id).filter { $0 == model.actorID || $0 == "human_ceo" })
      }
    }
  }

  private func binding(for agentID: String) -> Binding<Bool> {
    Binding(
      get: { participantIDs.contains(agentID) },
      set: { on in
        if on {
          participantIDs.insert(agentID)
        } else {
          participantIDs.remove(agentID)
        }
      }
    )
  }

  private func submit() async {
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedName.isEmpty {
      error = "Channel name is required."
      return
    }

    isBusy = true
    defer { isBusy = false }

    do {
      try await onCreate(
        trimmedName,
        visibility,
        selectedTeamID.isEmpty ? nil : selectedTeamID,
        participantIDs.sorted()
      )
      dismiss()
    } catch {
      self.error = error.localizedDescription
    }
  }
}

private struct CreateDMSheet: View {
  @Environment(\.dismiss) private var dismiss

  @ObservedObject var model: AppViewModel
  let onCreate: (String) async throws -> Void

  @State private var query = ""
  @State private var error = ""
  @State private var isBusy = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("New Direct Message")
        .font(.title3.weight(.semibold))

      TextField("Search workers", text: $query)
        .textFieldStyle(.roundedBorder)

      List(filteredAgents) { agent in
        Button {
          Task { await openDM(with: agent.id) }
        } label: {
          HStack {
            VStack(alignment: .leading, spacing: 1) {
              Text(agent.name)
                .foregroundStyle(.primary)
              Text("\(agent.role) · \(agent.provider)")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            if agent.id == model.actorID || agent.id == "human_ceo" {
              Text("You")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
        }
        .buttonStyle(.plain)
      }
      .listStyle(.inset)

      if !error.isEmpty {
        Text(error)
          .font(.caption)
          .foregroundStyle(.red)
      }

      HStack {
        Spacer()
        Button("Close") { dismiss() }
      }
    }
    .padding(18)
  }

  private var filteredAgents: [AgentSummary] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let base = model.agents.filter { !($0.id == model.actorID || $0.id == "human_ceo") }
    if trimmed.isEmpty { return base }

    return base.filter { agent in
      agent.name.lowercased().contains(trimmed) ||
      agent.role.lowercased().contains(trimmed) ||
      agent.provider.lowercased().contains(trimmed)
    }
  }

  private func openDM(with agentID: String) async {
    isBusy = true
    defer { isBusy = false }

    do {
      try await onCreate(agentID)
      dismiss()
    } catch {
      self.error = error.localizedDescription
    }
  }
}

private struct Banner: View {
  enum Kind {
    case info
    case error

    var color: Color {
      switch self {
      case .info:
        return .accentColor
      case .error:
        return .red
      }
    }

    var icon: String {
      switch self {
      case .info:
        return "checkmark.circle"
      case .error:
        return "exclamationmark.triangle.fill"
      }
    }
  }

  let message: String
  let kind: Kind

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: kind.icon)
      Text(message)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer()
    }
    .font(.caption)
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(kind.color.opacity(0.14), in: Capsule())
    .overlay {
      Capsule().stroke(kind.color.opacity(0.35), lineWidth: 1)
    }
    .padding(.horizontal, 12)
  }
}

private extension String {
  var prettyTimestamp: String {
    guard let date = ISO8601.parse(self) else {
      return self
    }
    return DateFormatter.readable.string(from: date)
  }
}

private enum ISO8601 {
  static func parse(_ text: String) -> Date? {
    let withFractionalSeconds = ISO8601DateFormatter()
    withFractionalSeconds.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let value = withFractionalSeconds.date(from: text) {
      return value
    }

    let withoutFractionalSeconds = ISO8601DateFormatter()
    withoutFractionalSeconds.formatOptions = [.withInternetDateTime]
    return withoutFractionalSeconds.date(from: text)
  }
}

private extension DateFormatter {
  static let readable: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter
  }()
}

private extension NumberFormatter {
  static let grouped: NumberFormatter = {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.maximumFractionDigits = 0
    return formatter
  }()

  static let usd4: NumberFormatter = {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "USD"
    formatter.maximumFractionDigits = 4
    formatter.minimumFractionDigits = 4
    return formatter
  }()
}
