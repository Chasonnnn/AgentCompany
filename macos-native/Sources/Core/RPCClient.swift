import Foundation

public protocol RPCClient: Sendable {
  func call(method: String, params: JSONObject) async throws -> JSONValue
}

public enum RPCClientError: Error, LocalizedError, Sendable {
  case cliPathMissing(String)
  case executionFailed(String)
  case rpcFailed(status: Int32, detail: String)
  case invalidJSON(String)

  public var errorDescription: String? {
    switch self {
    case .cliPathMissing(let path):
      return "Cannot find dist/cli.js at \(path). Set a valid CLI path in settings."
    case .executionFailed(let detail):
      return "Failed to execute CLI command: \(detail)"
    case .rpcFailed(_, let detail):
      return detail
    case .invalidJSON(let detail):
      return "RPC response is not valid JSON: \(detail)"
    }
  }
}

public struct RPCEnvironment: Equatable, Sendable {
  public var nodeBin: String
  public var cliPath: String
  public var workingDirectory: String

  public init(nodeBin: String, cliPath: String, workingDirectory: String) {
    self.nodeBin = nodeBin
    self.cliPath = cliPath
    self.workingDirectory = workingDirectory
  }

  public static func defaults() -> RPCEnvironment {
    let env = ProcessInfo.processInfo.environment
    let cwd = FileManager.default.currentDirectoryPath
    let nodeBin = env["AGENTCOMPANY_NODE_BIN"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    let cliPath = env["AGENTCOMPANY_CLI_PATH"]?.trimmingCharacters(in: .whitespacesAndNewlines)

    return RPCEnvironment(
      nodeBin: (nodeBin?.isEmpty == false ? nodeBin! : "node"),
      cliPath: (cliPath?.isEmpty == false ? cliPath! : cwd + "/dist/cli.js"),
      workingDirectory: cwd
    )
  }
}

public enum RPCCommandBuilder {
  public static func paramsJSONString(_ params: JSONObject) throws -> String {
    let payload = JSONValue.object(params)
    let data = try JSONEncoder().encode(payload)
    guard let json = String(data: data, encoding: .utf8) else {
      throw RPCClientError.invalidJSON("Unable to encode params as UTF-8")
    }
    return json
  }

  public static func commandArguments(cliPath: String, method: String, params: JSONObject) throws -> [String] {
    [
      cliPath,
      "rpc:call",
      "--method",
      method,
      "--params",
      try paramsJSONString(params)
    ]
  }
}

public struct LocalCLIClient: RPCClient {
  public var environment: RPCEnvironment

  public init(environment: RPCEnvironment) {
    self.environment = environment
  }

  public func call(method: String, params: JSONObject) async throws -> JSONValue {
    try await Task.detached(priority: .userInitiated) {
      try callSync(method: method, params: params)
    }.value
  }

  private func callSync(method: String, params: JSONObject) throws -> JSONValue {
    let cliURL = URL(fileURLWithPath: environment.cliPath)
    guard FileManager.default.fileExists(atPath: cliURL.path) else {
      throw RPCClientError.cliPathMissing(cliURL.path)
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.currentDirectoryURL = URL(fileURLWithPath: environment.workingDirectory)

    let commandArgs = try RPCCommandBuilder.commandArguments(
      cliPath: environment.cliPath,
      method: method,
      params: params
    )

    process.arguments = [environment.nodeBin] + commandArgs

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    do {
      try process.run()
    } catch {
      throw RPCClientError.executionFailed(error.localizedDescription)
    }

    process.waitUntilExit()
    let outputData = stdout.fileHandleForReading.readDataToEndOfFile()
    let errorData = stderr.fileHandleForReading.readDataToEndOfFile()
    let stderrText = String(data: errorData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    guard process.terminationStatus == 0 else {
      throw RPCClientError.rpcFailed(
        status: process.terminationStatus,
        detail: stderrText.isEmpty ? "RPC command failed" : stderrText
      )
    }

    do {
      return try JSONValue.decode(from: outputData)
    } catch {
      let raw = String(data: outputData, encoding: .utf8) ?? "<non-utf8>"
      throw RPCClientError.invalidJSON("\(error.localizedDescription). output=\(raw)")
    }
  }
}
