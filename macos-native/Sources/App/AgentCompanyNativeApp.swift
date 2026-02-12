import SwiftUI

@main
struct AgentCompanyNativeApp: App {
  @StateObject private var model = AppViewModel()

  var body: some Scene {
    WindowGroup("AgentCompany") {
      MainView()
        .environmentObject(model)
        .task {
          await model.refreshAll()
        }
    }
    .defaultSize(width: 1480, height: 920)
    .windowToolbarStyle(.unified)
  }
}
