import Foundation

public enum NativeProtocolSemantics {
    public static func validateResponse(_ response: NativeResponse, for request: NativeRequest) throws {
        guard response.id == request.id else { throw mismatch("Response id does not match its request.") }
        let sideEffecting = request.call.intent != .observe
        if !sideEffecting, response.operation != nil {
            throw mismatch("Observe responses must not claim an operation outcome.")
        }
        if sideEffecting {
            guard let receipt = response.operation,
                  receipt.operationID == request.call.operationID else {
                throw mismatch("Side-effecting response is missing its matching operation receipt.")
            }
            if response.isSuccess, receipt.outcome != .executed {
                throw mismatch("Successful side-effecting responses must prove executed.")
            }
        }
        if response.error?.retry == .safe, response.operation?.outcome != .notExecuted {
            throw mismatch("A safe retry disposition requires a notExecuted receipt.")
        }
    }

    public static func validateCall(_ call: NativeCall, against host: NativeHostDescriptor) throws {
        guard let method = host.methods.first(where: { $0.name == call.name }) else {
            throw WireValidation.invalid("Host does not advertise method '\(call.name)'.")
        }
        guard method.intent == call.intent, method.scopeKinds.contains(call.scope.kind) else {
            throw WireValidation.invalid("Call '\(call.name)' does not match its advertised intent and scope.")
        }
        if call.scope != .bootstrap, call.scope.hostInstanceID != host.hostInstanceID {
            throw WireValidation.invalid("Call '\(call.name)' targets a different or stale host instance.")
        }
    }

    public static func decodeHostDescriptor(_ value: NativeJSONValue) throws -> NativeHostDescriptor {
        let input = try WireValidation.object(value, label: "host", allowed: [
            "hostInstanceId", "platform", "backend", "methods", "maxMessageBytes",
        ])
        let hostID = try WireValidation.identifier(
            try WireValidation.required(input, "hostInstanceId", label: "host"), label: "host.hostInstanceId"
        )
        let platform = try WireValidation.identifier(
            try WireValidation.required(input, "platform", label: "host"), label: "host.platform"
        )
        let backend = try WireValidation.identifier(
            try WireValidation.required(input, "backend", label: "host"), label: "host.backend"
        )
        guard case let .array(rawMethods) = try WireValidation.required(input, "methods", label: "host"),
              !rawMethods.isEmpty else { throw WireValidation.invalid("host.methods must be a non-empty array.") }
        let methods = try rawMethods.enumerated().map { index, value in
            try decodeMethod(value, label: "host.methods[\(index)]")
        }
        guard Set(methods.map(\.name)).count == methods.count else {
            throw WireValidation.invalid("host.methods must be unique.")
        }
        guard let handshake = methods.first(where: { $0.name == "host.handshake" }),
              handshake.intent == .observe, handshake.scopeKinds == ["bootstrap"] else {
            throw WireValidation.invalid("host.methods must declare host.handshake as observe/bootstrap.")
        }
        for method in methods {
            if method.name != "host.handshake", method.scopeKinds.contains("bootstrap") {
                throw WireValidation.invalid("Only host.handshake may advertise bootstrap scope.")
            }
            if method.name == "session.launch",
               (method.intent != .lifecycle || method.scopeKinds != ["host"]) {
                throw WireValidation.invalid("session.launch must be advertised as lifecycle/host.")
            }
        }
        let maximum = try WireValidation.integer(
            try WireValidation.required(input, "maxMessageBytes", label: "host"),
            label: "host.maxMessageBytes", minimum: 1, maximum: NativeProtocolV1.maxMessageBytes
        )
        return NativeHostDescriptor(hostInstanceID: hostID, platform: platform, backend: backend,
                                    methods: methods, maxMessageBytes: maximum)
    }

    private static func decodeMethod(_ value: NativeJSONValue, label: String) throws -> NativeMethodDescriptor {
        let input = try WireValidation.object(value, label: label, allowed: ["name", "intent", "scopeKinds"])
        let name = try WireValidation.methodName(try WireValidation.required(input, "name", label: label), label: "\(label).name")
        let intentText = try WireValidation.text(try WireValidation.required(input, "intent", label: label), label: "\(label).intent")
        guard let intent = NativeOperationIntent(rawValue: intentText) else {
            throw WireValidation.invalid("\(label).intent is not supported.")
        }
        guard case let .array(rawKinds) = try WireValidation.required(input, "scopeKinds", label: label),
              !rawKinds.isEmpty else { throw WireValidation.invalid("\(label).scopeKinds must be a non-empty array.") }
        let allowed = Set(["bootstrap", "host", "session", "handle"])
        let kinds = try rawKinds.enumerated().map { index, value in
            let kind = try WireValidation.text(value, label: "\(label).scopeKinds[\(index)]")
            guard allowed.contains(kind) else { throw WireValidation.invalid("\(label).scopeKinds contains an unsupported value.") }
            return kind
        }
        guard Set(kinds).count == kinds.count else { throw WireValidation.invalid("\(label).scopeKinds must be unique.") }
        return NativeMethodDescriptor(name: name, intent: intent, scopeKinds: kinds)
    }

    private static func mismatch(_ message: String) -> NativeProtocolError {
        NativeProtocolError(code: "correlation_mismatch", message: message)
    }
}
