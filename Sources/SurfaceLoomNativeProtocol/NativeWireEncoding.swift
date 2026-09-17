import Foundation

public extension NativeWireCodec {
    static func encode(_ message: NativeWireMessage) throws -> Data {
        let value: NativeJSONValue
        switch message {
        case let .request(request): value = requestJSON(request)
        case let .cancel(cancel): value = cancelJSON(cancel)
        case let .response(response): value = responseJSON(response)
        }
        _ = try decodeMessage(value)
        var data = try NativeJSONWriter.encode(value)
        data.append(0x0A)
        guard data.count <= NativeProtocolV1.maxMessageBytes else {
            throw NativeProtocolError(code: "message_too_large", message: "Wire frame exceeds the protocol byte limit.")
        }
        return data
    }

    static func encodeFailureOrEmergency(
        id: String,
        code: String,
        category: NativeErrorCategory,
        message: String,
        operation: NativeOperationReceipt? = nil
    ) -> Data {
        let response = NativeResponse(
            id: id,
            error: NativeWireError(code: code, category: category, message: message, retry: .never),
            operation: operation
        )
        do { return try encode(.response(response)) }
        catch {
            // This constant is independent of all inbound text and is permanently
            // below the wire cap. It is the last-resort terminal frame.
            return Data("{\"protocol\":\"surfaceloom.native\",\"version\":\"1.0\",\"type\":\"response\",\"id\":\"invalid\",\"ok\":false,\"error\":{\"code\":\"host_internal_error\",\"category\":\"internal\",\"message\":\"The native host failed safely.\",\"retry\":\"never\"},\"operation\":null}\n".utf8)
        }
    }

    private static func requestJSON(_ request: NativeRequest) -> NativeJSONValue {
        var call: NativeJSONObject = [
            "name": .string(request.call.name),
            "intent": .string(request.call.intent.rawValue),
            "scope": scopeJSON(request.call.scope),
            "payload": .object(request.call.payload),
        ]
        if let operationID = request.call.operationID { call["operationId"] = .string(operationID) }
        return .object([
            "protocol": .string(NativeProtocolV1.name), "version": .string(NativeProtocolV1.version),
            "type": .string("request"), "id": .string(request.id),
            "deadline": .object(["timeoutMs": .number(Double(request.timeoutMilliseconds))]),
            "call": .object(call),
        ])
    }

    private static func cancelJSON(_ cancel: NativeCancel) -> NativeJSONValue {
        .object([
            "protocol": .string(NativeProtocolV1.name), "version": .string(NativeProtocolV1.version),
            "type": .string("cancel"), "id": .string(cancel.id),
            "requestId": .string(cancel.requestID), "reason": .string(cancel.reason.rawValue),
        ])
    }

    private static func responseJSON(_ response: NativeResponse) -> NativeJSONValue {
        var value: NativeJSONObject = [
            "protocol": .string(NativeProtocolV1.name), "version": .string(NativeProtocolV1.version),
            "type": .string("response"), "id": .string(response.id),
            "ok": .bool(response.isSuccess),
            "operation": response.operation.map(receiptJSON) ?? .null,
        ]
        if let result = response.result { value["result"] = result }
        if let error = response.error { value["error"] = errorJSON(error) }
        return .object(value)
    }

    private static func scopeJSON(_ scope: NativeScope) -> NativeJSONValue {
        switch scope {
        case .bootstrap: return .object(["kind": .string("bootstrap")])
        case let .host(host): return .object(["kind": .string("host"), "hostInstanceId": .string(host)])
        case let .session(host, session):
            return .object(["kind": .string("session"), "hostInstanceId": .string(host), "sessionId": .string(session)])
        case let .handle(host, session, handle):
            return .object(["kind": .string("handle"), "hostInstanceId": .string(host),
                            "sessionId": .string(session), "handleId": .string(handle)])
        }
    }

    private static func receiptJSON(_ receipt: NativeOperationReceipt) -> NativeJSONValue {
        .object(["operationId": .string(receipt.operationID), "outcome": .string(receipt.outcome.rawValue)])
    }

    private static func errorJSON(_ error: NativeWireError) -> NativeJSONValue {
        var value: NativeJSONObject = [
            "code": .string(error.code), "category": .string(error.category.rawValue),
            "message": .string(error.message), "retry": .string(error.retry.rawValue),
        ]
        if let details = error.details { value["details"] = .object(details) }
        return .object(value)
    }
}
