// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "AgentCompanyNative",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "AgentCompanyNative", targets: ["AgentCompanyNative"]),
    .library(name: "AgentCompanyNativeCore", targets: ["AgentCompanyNativeCore"])
  ],
  targets: [
    .target(
      name: "AgentCompanyNativeCore",
      path: "Sources/Core"
    ),
    .executableTarget(
      name: "AgentCompanyNative",
      dependencies: ["AgentCompanyNativeCore"],
      path: "Sources/App"
    ),
    .testTarget(
      name: "AgentCompanyNativeCoreTests",
      dependencies: ["AgentCompanyNativeCore"],
      path: "Tests/CoreTests"
    )
  ]
)
