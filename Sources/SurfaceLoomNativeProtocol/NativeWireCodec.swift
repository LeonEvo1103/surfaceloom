import Foundation

public enum NativeWireCodec {
    public static func parseFrame(_ frame: NativeWireFrame) throws -> NativeJSONValue {
        guard frame.delimiterBytes == 1 || frame.delimiterBytes == 2 else {
            throw NativeProtocolError(code: "invalid_frame", message: "Invalid frame delimiter.")
        }
        guard frame.bytes.count + frame.delimiterBytes <= NativeProtocolV1.maxMessageBytes else {
            throw NativeProtocolError(code: "message_too_large", message: "Wire frame exceeds the protocol byte limit.")
        }
        if frame.bytes.starts(with: [0xEF, 0xBB, 0xBF]) {
            throw NativeProtocolError(code: "invalid_json", message: "Wire frame is not valid JSON.")
        }
        guard let text = String(data: frame.bytes, encoding: .utf8) else {
            throw NativeProtocolError(code: "invalid_utf8", message: "Wire frame is not valid UTF-8.")
        }
        guard !text.isEmpty, !text.contains("\r"), !text.contains("\n") else {
            throw NativeProtocolError(code: "invalid_frame", message: "Wire frame must contain exactly one JSON object.")
        }
        return try StrictJSONParser.parse(text)
    }

    public static func decode(_ frame: NativeWireFrame) throws -> NativeWireMessage {
        try decodeMessage(parseFrame(frame))
    }

    public static func decodeMessage(_ value: NativeJSONValue) throws -> NativeWireMessage {
        let broad = try WireValidation.object(value, label: "message", allowed: [
            "protocol", "version", "type", "id", "deadline", "call", "requestId", "reason",
            "ok", "result", "error", "operation",
        ])
        let type = try WireValidation.text(try WireValidation.required(broad, "type", label: "message"), label: "message.type")
        switch type {
        case "request": return .request(try decodeRequest(value))
        case "cancel": return .cancel(try decodeCancel(value))
        case "response": return .response(try decodeResponse(value))
        default: throw WireValidation.invalid("message.type is not supported.")
        }
    }

    public static func exactProtocolMarker(in value: NativeJSONValue) -> Bool {
        guard case let .object(object) = value,
              case let .string(protocolName)? = object["protocol"] else { return false }
        return protocolName == NativeProtocolV1.name
    }

    public static func recoverableMessageID(in value: NativeJSONValue) -> String? {
        guard case let .object(object) = value, let candidate = object["id"] else { return nil }
        return try? WireValidation.identifier(candidate, label: "message.id")
    }

    private static func decodeRequest(_ value: NativeJSONValue) throws -> NativeRequest {
        let input = try WireValidation.object(value, label: "message", allowed: [
            "protocol", "version", "type", "id", "deadline", "call",
        ])
        let id = try header(input, expectedType: "request")
        let deadline = try WireValidation.object(
            try WireValidation.required(input, "deadline", label: "message"),
            label: "deadline", allowed: ["timeoutMs"]
        )
        let timeout = try WireValidation.integer(
            try WireValidation.required(deadline, "timeoutMs", label: "deadline"),
            label: "deadline.timeoutMs", minimum: 0, maximum: NativeProtocolV1.maxDeadlineMilliseconds
        )
        return NativeRequest(
            id: id,
            timeoutMilliseconds: timeout,
            call: try decodeCall(try WireValidation.required(input, "call", label: "message"), requestID: id)
        )
    }

    private static func decodeCancel(_ value: NativeJSONValue) throws -> NativeCancel {
        let input = try WireValidation.object(value, label: "message", allowed: [
            "protocol", "version", "type", "id", "requestId", "reason",
        ])
        let id = try header(input, expectedType: "cancel")
        let requestID = try WireValidation.identifier(
            try WireValidation.required(input, "requestId", label: "message"), label: "message.requestId"
        )
        guard id != requestID else { throw WireValidation.invalid("Cancellation message id must differ from requestId.", requestID: id) }
        let reasonText = try WireValidation.text(
            try WireValidation.required(input, "reason", label: "message"), label: "message.reason"
        )
        guard let reason = NativeCancellationReason(rawValue: reasonText) else {
            throw WireValidation.invalid("message.reason is not a supported value.", requestID: id)
        }
        return NativeCancel(id: id, requestID: requestID, reason: reason)
    }

    private static func decodeCall(_ value: NativeJSONValue, requestID: String) throws -> NativeCall {
        let input = try WireValidation.object(value, label: "call", allowed: [
            "name", "intent", "scope", "payload", "operationId",
        ])
        let name = try WireValidation.methodName(try WireValidation.required(input, "name", label: "call"), label: "call.name")
        let intentText = try WireValidation.text(try WireValidation.required(input, "intent", label: "call"), label: "call.intent")
        guard let intent = NativeOperationIntent(rawValue: intentText) else {
            throw WireValidation.invalid("call.intent is not a supported value.", requestID: requestID)
        }
        let scope = try decodeScope(try WireValidation.required(input, "scope", label: "call"))
        let payloadValue = try WireValidation.required(input, "payload", label: "call")
        guard case let .object(payload) = payloadValue else { throw WireValidation.invalid("call.payload must be an object.", requestID: requestID) }
        try payloadValue.validateJSON(maximumDepth: 32)
        let operationID = try input["operationId"].map { try WireValidation.identifier($0, label: "call.operationId") }
        if intent == .observe && operationID != nil { throw WireValidation.invalid("Observe calls must not carry operationId.", requestID: requestID) }
        if intent != .observe && operationID == nil { throw WireValidation.invalid("Mutate and lifecycle calls require operationId.", requestID: requestID) }
        guard (scope == .bootstrap) == (name == "host.handshake") else {
            throw WireValidation.invalid("Only host.handshake may use bootstrap scope, and it must use that scope.", requestID: requestID)
        }
        if name == "host.handshake" && intent != .observe { throw WireValidation.invalid("host.handshake must be an observe call.", requestID: requestID) }
        if name == "session.launch" && (intent != .lifecycle || scope.kind != "host") {
            throw WireValidation.invalid("session.launch must be a host-scoped lifecycle call.", requestID: requestID)
        }
        return NativeCall(name: name, intent: intent, scope: scope, payload: payload, operationID: operationID)
    }

    private static func decodeScope(_ value: NativeJSONValue) throws -> NativeScope {
        guard case let .object(raw) = value else { throw WireValidation.invalid("call.scope must be an object.") }
        let kind = try WireValidation.text(try WireValidation.required(raw, "kind", label: "call.scope"), label: "call.scope.kind")
        let allowed: Set<String>
        switch kind {
        case "bootstrap": allowed = ["kind"]
        case "host": allowed = ["kind", "hostInstanceId"]
        case "session": allowed = ["kind", "hostInstanceId", "sessionId"]
        case "handle": allowed = ["kind", "hostInstanceId", "sessionId", "handleId"]
        default: throw WireValidation.invalid("call.scope.kind is not supported.")
        }
        let input = try WireValidation.object(value, label: "call.scope", allowed: allowed)
        func identifier(_ key: String) throws -> String {
            try WireValidation.identifier(try WireValidation.required(input, key, label: "call.scope"), label: "call.scope.\(key)")
        }
        switch kind {
        case "bootstrap": return .bootstrap
        case "host": return .host(hostInstanceID: try identifier("hostInstanceId"))
        case "session": return .session(hostInstanceID: try identifier("hostInstanceId"), sessionID: try identifier("sessionId"))
        default: return .handle(hostInstanceID: try identifier("hostInstanceId"), sessionID: try identifier("sessionId"), handleID: try identifier("handleId"))
        }
    }

    private static func decodeResponse(_ value: NativeJSONValue) throws -> NativeResponse {
        guard case let .object(raw) = value else { throw WireValidation.invalid("message must be an object.") }
        guard case let .bool(ok)? = raw["ok"] else { throw WireValidation.invalid("message.ok must be boolean.") }
        let allowed: Set<String> = ok
            ? ["protocol", "version", "type", "id", "ok", "result", "operation"]
            : ["protocol", "version", "type", "id", "ok", "error", "operation"]
        let input = try WireValidation.object(value, label: "message", allowed: allowed)
        let id = try header(input, expectedType: "response")
        let operation = try decodeReceipt(try WireValidation.required(input, "operation", label: "message"))
        if ok {
            let result = try WireValidation.required(input, "result", label: "message")
            try result.validateJSON(maximumDepth: 32)
            return NativeResponse(id: id, result: result, operation: operation)
        }
        return NativeResponse(
            id: id,
            error: try decodeWireError(try WireValidation.required(input, "error", label: "message")),
            operation: operation
        )
    }

    private static func decodeReceipt(_ value: NativeJSONValue) throws -> NativeOperationReceipt? {
        if value == .null { return nil }
        let input = try WireValidation.object(value, label: "operation", allowed: ["operationId", "outcome"])
        let operationID = try WireValidation.identifier(
            try WireValidation.required(input, "operationId", label: "operation"), label: "operation.operationId"
        )
        let outcomeText = try WireValidation.text(
            try WireValidation.required(input, "outcome", label: "operation"), label: "operation.outcome"
        )
        guard let outcome = NativeOperationOutcome(rawValue: outcomeText) else {
            throw WireValidation.invalid("operation.outcome is not a supported value.")
        }
        return NativeOperationReceipt(operationID: operationID, outcome: outcome)
    }

    private static func decodeWireError(_ value: NativeJSONValue) throws -> NativeWireError {
        let input = try WireValidation.object(value, label: "error", allowed: [
            "code", "category", "message", "retry", "details",
        ])
        let code = try WireValidation.identifier(try WireValidation.required(input, "code", label: "error"), label: "error.code")
        let categoryText = try WireValidation.text(try WireValidation.required(input, "category", label: "error"), label: "error.category")
        let retryText = try WireValidation.text(try WireValidation.required(input, "retry", label: "error"), label: "error.retry")
        guard let category = NativeErrorCategory(rawValue: categoryText),
              let retry = NativeRetryDisposition(rawValue: retryText) else {
            throw WireValidation.invalid("error category or retry disposition is not supported.")
        }
        let message = try WireValidation.text(
            try WireValidation.required(input, "message", label: "error"), label: "error.message", maximum: 2_048
        )
        var details: NativeJSONObject?
        if let detailsValue = input["details"] {
            guard case let .object(object) = detailsValue else { throw WireValidation.invalid("error.details must be an object.") }
            try detailsValue.validateJSON(maximumDepth: 32)
            details = object
        }
        return NativeWireError(code: code, category: category, message: message, retry: retry, details: details)
    }

    private static func header(_ input: NativeJSONObject, expectedType: String) throws -> String {
        let recoverableID = input["id"].flatMap { try? WireValidation.identifier($0, label: "message.id") }
        let protocolName = try WireValidation.text(
            try WireValidation.required(input, "protocol", label: "message"), label: "message.protocol"
        )
        guard protocolName == NativeProtocolV1.name else {
            throw NativeProtocolError(code: "unsupported_protocol", message: "Unsupported native protocol.", requestID: recoverableID)
        }
        let version = try WireValidation.text(
            try WireValidation.required(input, "version", label: "message"), label: "message.version"
        )
        guard version == NativeProtocolV1.version else {
            throw NativeProtocolError(code: "unsupported_version", message: "Unsupported native protocol version.", requestID: recoverableID)
        }
        let id = try WireValidation.identifier(try WireValidation.required(input, "id", label: "message"), label: "message.id")
        let type = try WireValidation.text(try WireValidation.required(input, "type", label: "message"), label: "message.type")
        guard type == expectedType else { throw WireValidation.invalid("Expected a \(expectedType) message.", requestID: id) }
        return id
    }

}
