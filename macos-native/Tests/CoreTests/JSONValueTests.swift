import XCTest
@testable import AgentCompanyNativeCore

final class JSONValueTests: XCTestCase {
  func testDecodeNestedObjectAndTypedAccessors() throws {
    let raw = #"{"project":{"project_id":"p1","progress_pct":72,"risk_flags":["blocked"],"healthy":true}}"#
    let data = Data(raw.utf8)

    let value = try JSONDecoder().decode(JSONValue.self, from: data)
    let project = try XCTUnwrap(value.objectValue?["project"]?.objectValue)

    XCTAssertEqual(project.string("project_id"), "p1")
    XCTAssertEqual(project.int("progress_pct"), 72)
    XCTAssertEqual(project.array("risk_flags")?.first?.stringValue, "blocked")
    XCTAssertEqual(project.bool("healthy"), true)
  }

  func testJSONStringEncodingIsStable() throws {
    let params: JSONObject = [
      "workspace_dir": .string("/tmp/work"),
      "scope": .string("project"),
      "project_id": .string("project_123")
    ]

    let json = try RPCCommandBuilder.paramsJSONString(params)
    let object = try JSONSerialization.jsonObject(with: Data(json.utf8), options: []) as? [String: String]

    XCTAssertEqual(object?["workspace_dir"], "/tmp/work")
    XCTAssertEqual(object?["project_id"], "project_123")
    XCTAssertEqual(object?["scope"], "project")
  }

  func testCommandArgumentsContainMethodAndParams() throws {
    let args = try RPCCommandBuilder.commandArguments(
      cliPath: "/Users/chason/AgentCompany/dist/cli.js",
      method: "pm.snapshot",
      params: ["workspace_dir": .string("/tmp/work")]
    )

    XCTAssertEqual(args[0], "/Users/chason/AgentCompany/dist/cli.js")
    XCTAssertEqual(args[1], "rpc:call")
    XCTAssertEqual(args[2], "--method")
    XCTAssertEqual(args[3], "pm.snapshot")
    XCTAssertEqual(args[4], "--params")
    XCTAssertTrue(args[5].contains("workspace_dir"))
  }
}
