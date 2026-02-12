import Foundation

public typealias JSONObject = [String: JSONValue]

public enum JSONValue: Codable, Equatable, Sendable {
  case object(JSONObject)
  case array([JSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
      return
    }
    if let object = try? container.decode(JSONObject.self) {
      self = .object(object)
      return
    }
    if let array = try? container.decode([JSONValue].self) {
      self = .array(array)
      return
    }
    if let bool = try? container.decode(Bool.self) {
      self = .bool(bool)
      return
    }
    if let string = try? container.decode(String.self) {
      self = .string(string)
      return
    }
    if let number = try? container.decode(Double.self) {
      self = .number(number)
      return
    }

    throw DecodingError.dataCorruptedError(
      in: container,
      debugDescription: "Unsupported JSON value"
    )
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .object(let object):
      try container.encode(object)
    case .array(let array):
      try container.encode(array)
    case .string(let string):
      try container.encode(string)
    case .number(let number):
      try container.encode(number)
    case .bool(let bool):
      try container.encode(bool)
    case .null:
      try container.encodeNil()
    }
  }

  public var objectValue: JSONObject? {
    guard case .object(let object) = self else { return nil }
    return object
  }

  public var arrayValue: [JSONValue]? {
    guard case .array(let array) = self else { return nil }
    return array
  }

  public var stringValue: String? {
    guard case .string(let string) = self else { return nil }
    return string
  }

  public var boolValue: Bool? {
    guard case .bool(let bool) = self else { return nil }
    return bool
  }

  public var numberValue: Double? {
    guard case .number(let number) = self else { return nil }
    return number
  }

  public var intValue: Int? {
    guard case .number(let number) = self else { return nil }
    return Int(number)
  }
}

public extension Dictionary where Key == String, Value == JSONValue {
  func string(_ key: String, default defaultValue: String = "") -> String {
    self[key]?.stringValue ?? defaultValue
  }

  func bool(_ key: String) -> Bool? {
    self[key]?.boolValue
  }

  func int(_ key: String) -> Int? {
    self[key]?.intValue
  }

  func double(_ key: String) -> Double? {
    self[key]?.numberValue
  }

  func array(_ key: String) -> [JSONValue]? {
    self[key]?.arrayValue
  }

  func object(_ key: String) -> JSONObject? {
    self[key]?.objectValue
  }
}

public extension JSONValue {
  static func from(any: Any) -> JSONValue {
    switch any {
    case let object as [String: Any]:
      var mapped: JSONObject = [:]
      for (key, value) in object {
        mapped[key] = .from(any: value)
      }
      return .object(mapped)
    case let array as [Any]:
      return .array(array.map(JSONValue.from(any:)))
    case let string as String:
      return .string(string)
    case let bool as Bool:
      return .bool(bool)
    case let number as NSNumber:
      return .number(number.doubleValue)
    default:
      return .null
    }
  }

  static func decode(from data: Data) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: data)
  }
}
