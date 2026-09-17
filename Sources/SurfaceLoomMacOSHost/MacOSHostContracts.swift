import Foundation
import SurfaceLoomNativeProtocol

enum MacOSHostMethod {
    static let handshake = "host.handshake"
    static let doctor = "host.doctor"
    static let capabilities = "capabilities.get"
    static let launch = "session.launch"
    static let attach = "session.attach"
    static let release = "session.release"
    static let terminate = "session.terminate"
    static let find = "element.find"
    static let get = "element.get"
    static let action = "element.action"

    static let advertised = [
        NativeMethodDescriptor(name: handshake, intent: .observe, scopeKinds: ["bootstrap"]),
        NativeMethodDescriptor(name: doctor, intent: .observe, scopeKinds: ["host"]),
        NativeMethodDescriptor(name: capabilities, intent: .observe, scopeKinds: ["host"]),
        NativeMethodDescriptor(name: launch, intent: .lifecycle, scopeKinds: ["host"]),
        NativeMethodDescriptor(name: attach, intent: .lifecycle, scopeKinds: ["host"]),
        NativeMethodDescriptor(name: release, intent: .lifecycle, scopeKinds: ["session"]),
        NativeMethodDescriptor(name: terminate, intent: .lifecycle, scopeKinds: ["session"]),
        NativeMethodDescriptor(name: find, intent: .observe, scopeKinds: ["session", "handle"]),
        NativeMethodDescriptor(name: get, intent: .observe, scopeKinds: ["handle"]),
        NativeMethodDescriptor(name: action, intent: .mutate, scopeKinds: ["handle"]),
    ]
}

enum MacOSSessionOwnership: String, Sendable { case owned, borrowed }

struct MacOSApplicationIdentity: Equatable, Hashable, Sendable {
    let processID: Int32
    let startSeconds: UInt64
    let startMicroseconds: UInt64
    let bundleIdentifier: String?
}

struct MacOSLaunchSpec: Sendable {
    let path: String
    let arguments: [String]
    let workingDirectory: String?
    let environment: [String: String]
}

struct MacOSAXLocator: Equatable, Sendable {
    let identifier: String?
    let role: String?
    let title: String?
}

struct MacOSFindSpec: Sendable {
    let locator: MacOSAXLocator
    let timeoutMilliseconds: Int
    let pollIntervalMilliseconds: Int
}

enum MacOSAXAction: String, Sendable { case press, setValue, focus }

struct MacOSActionSpec: Sendable {
    let action: MacOSAXAction
    let value: String?
    let expectedLocator: MacOSAXLocator
    let expectedProcessID: Int32
    let expectedRootHandleID: String
}

enum MacOSPayload {
    static func handshake(_ payload: NativeJSONObject) throws {
        try fields(payload, allowed: ["client", "supportedVersions"])
        if let client = payload["client"] { _ = try text(client, "client", maximum: 128) }
        if let versions = payload["supportedVersions"] {
            let values = try strings(versions, maximumCount: 16)
            guard values.contains(NativeProtocolV1.version) else {
                throw macOSBackendError("protocol_version_mismatch", .protocolError,
                                        "The client does not advertise native protocol version 1.0.")
            }
        }
    }

    static func empty(_ payload: NativeJSONObject) throws {
        try fields(payload, allowed: [])
    }

    static func launch(_ payload: NativeJSONObject) throws -> MacOSLaunchSpec {
        try fields(payload, allowed: ["executable", "workingDirectory", "environment"])
        let executable = try object(payload["executable"], "executable")
        try fields(executable, allowed: ["path", "arguments"])
        let path = try text(executable["path"], "executable.path", maximum: 4_096)
        guard path.hasPrefix("/"), !path.contains("\0") else { throw invalid() }
        let arguments = try strings(executable["arguments"] ?? .array([]), maximumCount: 128,
                                    allowEmpty: true)
        let workingDirectory = try optionalText(payload["workingDirectory"], maximum: 4_096)
        if let workingDirectory, !workingDirectory.hasPrefix("/") { throw invalid() }
        let environmentObject = try object(payload["environment"] ?? .object([:]), "environment")
        guard environmentObject.count <= 128 else { throw invalid() }
        var environment: [String: String] = [:]
        for key in environmentObject.keys {
            guard isEnvironmentName(key) else { throw invalid() }
            environment[key] = try content(environmentObject[key], maximum: 8_192, allowEmpty: true)
        }
        return MacOSLaunchSpec(path: path, arguments: arguments,
                               workingDirectory: workingDirectory, environment: environment)
    }

    static func attach(_ payload: NativeJSONObject) throws -> Int32 {
        try fields(payload, allowed: ["processId"])
        let value = try integer(payload["processId"], minimum: 1, maximum: Int(Int32.max))
        return Int32(value)
    }

    static func locatorPayload(_ payload: NativeJSONObject) throws -> MacOSFindSpec {
        try fields(payload, allowed: ["locator", "wait"])
        var timeout = 5_000
        var poll = 100
        if let wait = payload["wait"] {
            let value = try object(wait, "wait")
            try fields(value, allowed: ["timeoutMs", "pollIntervalMs"])
            if let value = value["timeoutMs"] { timeout = try integer(value, minimum: 0, maximum: 120_000) }
            if let value = value["pollIntervalMs"] { poll = try integer(value, minimum: 1, maximum: 10_000) }
        }
        return MacOSFindSpec(locator: try locator(try object(payload["locator"], "locator")),
                             timeoutMilliseconds: timeout, pollIntervalMilliseconds: poll)
    }

    static func action(_ payload: NativeJSONObject) throws -> MacOSActionSpec {
        try fields(payload, allowed: ["action", "value", "expectedTarget"])
        guard let action = MacOSAXAction(rawValue: try text(payload["action"], "action", maximum: 32))
        else { throw unsupportedAction() }
        let value = try optionalContent(payload["value"], maximum: 65_536)
        guard (action == .setValue) == (value != nil) else { throw invalid() }
        let expected = try object(payload["expectedTarget"], "expectedTarget")
        try fields(expected, allowed: ["locator", "processId", "rootElementId"])
        return MacOSActionSpec(
            action: action,
            value: value,
            expectedLocator: try locator(try object(expected["locator"], "locator")),
            expectedProcessID: Int32(try integer(expected["processId"], minimum: 1, maximum: Int(Int32.max))),
            expectedRootHandleID: try text(expected["rootElementId"], "rootElementId", maximum: 128)
        )
    }

    private static func locator(_ value: NativeJSONObject) throws -> MacOSAXLocator {
        try fields(value, allowed: ["backend", "identifier", "role", "title"])
        guard try text(value["backend"], "locator.backend", maximum: 16) == "ax" else { throw invalid() }
        let result = MacOSAXLocator(
            identifier: try optionalText(value["identifier"], maximum: 512),
            role: try optionalText(value["role"], maximum: 128),
            title: try optionalText(value["title"], maximum: 1_024)
        )
        guard result.identifier != nil || result.role != nil || result.title != nil else { throw invalid() }
        return result
    }

    private static func fields(_ value: NativeJSONObject, allowed: Set<String>) throws {
        guard value.keys.allSatisfy(allowed.contains) else { throw invalid() }
    }

    private static func object(_ value: NativeJSONValue?, _ label: String) throws -> NativeJSONObject {
        guard case let .object(result)? = value else { _ = label; throw invalid() }
        return result
    }

    private static func text(_ value: NativeJSONValue?, _ label: String, maximum: Int) throws -> String {
        guard case let .string(result)? = value, !result.isEmpty,
              result.utf8.count <= maximum, !result.contains("\0"),
              !result.contains("\r"), !result.contains("\n")
        else { _ = label; throw invalid() }
        return result
    }

    private static func optionalText(_ value: NativeJSONValue?, maximum: Int) throws -> String? {
        if value == nil || value == .null { return nil }
        return try text(value, "value", maximum: maximum)
    }

    private static func optionalContent(_ value: NativeJSONValue?, maximum: Int) throws -> String? {
        guard let value else { return nil }
        guard case let .string(result) = value, result.utf8.count <= maximum,
              !result.contains("\0") else { throw invalid() }
        return result
    }

    private static func integer(_ value: NativeJSONValue?, minimum: Int, maximum: Int) throws -> Int {
        guard case let .number(number)? = value, number.rounded() == number,
              number >= Double(minimum), number <= Double(maximum) else { throw invalid() }
        return Int(number)
    }

    private static func strings(
        _ value: NativeJSONValue,
        maximumCount: Int,
        allowEmpty: Bool = false
    ) throws -> [String] {
        guard case let .array(values) = value, values.count <= maximumCount else { throw invalid() }
        return try values.map { try content($0, maximum: 8_192, allowEmpty: allowEmpty) }
    }

    private static func content(
        _ value: NativeJSONValue?,
        maximum: Int,
        allowEmpty: Bool
    ) throws -> String {
        guard case let .string(result)? = value,
              (allowEmpty || !result.isEmpty), result.utf8.count <= maximum,
              !result.contains("\0") else { throw invalid() }
        return result
    }

    private static func isEnvironmentName(_ value: String) -> Bool {
        guard let first = value.utf8.first,
              first == 95 || (65...90).contains(first) || (97...122).contains(first) else { return false }
        return value.utf8.dropFirst().allSatisfy {
            $0 == 95 || (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0)
        }
    }

    static func invalid() -> NativeHostBackendError {
        NativeHostBackendError(code: "invalid_request", category: .invalidRequest,
                               safeMessage: "The method payload is invalid.")
    }

    private static func unsupportedAction() -> NativeHostBackendError {
        NativeHostBackendError(code: "action_not_supported", category: .unsupported,
                               safeMessage: "The requested AX action is unsupported.")
    }
}
