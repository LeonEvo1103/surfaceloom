import Foundation

public enum NativeScope: Equatable, Sendable {
    case bootstrap
    case host(hostInstanceID: String)
    case session(hostInstanceID: String, sessionID: String)
    case handle(hostInstanceID: String, sessionID: String, handleID: String)

    public var kind: String {
        switch self {
        case .bootstrap: return "bootstrap"
        case .host: return "host"
        case .session: return "session"
        case .handle: return "handle"
        }
    }

    public var hostInstanceID: String? {
        switch self {
        case .bootstrap: return nil
        case let .host(value), let .session(value, _), let .handle(value, _, _): return value
        }
    }
}

public struct NativeCall: Equatable, Sendable {
    public let name: String
    public let intent: NativeOperationIntent
    public let scope: NativeScope
    public let payload: NativeJSONObject
    public let operationID: String?

    public init(
        name: String,
        intent: NativeOperationIntent,
        scope: NativeScope,
        payload: NativeJSONObject,
        operationID: String? = nil
    ) {
        self.name = name
        self.intent = intent
        self.scope = scope
        self.payload = payload
        self.operationID = operationID
    }
}

public struct NativeRequest: Equatable, Sendable {
    public let id: String
    public let timeoutMilliseconds: Int
    public let call: NativeCall

    public init(id: String, timeoutMilliseconds: Int, call: NativeCall) {
        self.id = id
        self.timeoutMilliseconds = timeoutMilliseconds
        self.call = call
    }
}

public struct NativeCancel: Equatable, Sendable {
    public let id: String
    public let requestID: String
    public let reason: NativeCancellationReason

    public init(id: String, requestID: String, reason: NativeCancellationReason) {
        self.id = id
        self.requestID = requestID
        self.reason = reason
    }
}

public struct NativeOperationReceipt: Equatable, Sendable {
    public let operationID: String
    public let outcome: NativeOperationOutcome

    public init(operationID: String, outcome: NativeOperationOutcome) {
        self.operationID = operationID
        self.outcome = outcome
    }
}

public struct NativeWireError: Equatable, Sendable {
    public let code: String
    public let category: NativeErrorCategory
    public let message: String
    public let retry: NativeRetryDisposition
    public let details: NativeJSONObject?

    public init(
        code: String,
        category: NativeErrorCategory,
        message: String,
        retry: NativeRetryDisposition,
        details: NativeJSONObject? = nil
    ) {
        self.code = code
        self.category = category
        self.message = message
        self.retry = retry
        self.details = details
    }
}

public struct NativeResponse: Equatable, Sendable {
    public let id: String
    public let result: NativeJSONValue?
    public let error: NativeWireError?
    public let operation: NativeOperationReceipt?

    public var isSuccess: Bool { error == nil }

    public init(
        id: String,
        result: NativeJSONValue,
        operation: NativeOperationReceipt? = nil
    ) {
        self.id = id
        self.result = result
        self.error = nil
        self.operation = operation
    }

    public init(
        id: String,
        error: NativeWireError,
        operation: NativeOperationReceipt? = nil
    ) {
        self.id = id
        self.result = nil
        self.error = error
        self.operation = operation
    }
}

public enum NativeWireMessage: Equatable, Sendable {
    case request(NativeRequest)
    case cancel(NativeCancel)
    case response(NativeResponse)
}

public struct NativeMethodDescriptor: Equatable, Sendable {
    public let name: String
    public let intent: NativeOperationIntent
    public let scopeKinds: [String]

    public init(name: String, intent: NativeOperationIntent, scopeKinds: [String]) {
        self.name = name
        self.intent = intent
        self.scopeKinds = scopeKinds
    }
}

public struct NativeHostDescriptor: Equatable, Sendable {
    public let hostInstanceID: String
    public let platform: String
    public let backend: String
    public let methods: [NativeMethodDescriptor]
    public let maxMessageBytes: Int

    public init(
        hostInstanceID: String,
        platform: String,
        backend: String,
        methods: [NativeMethodDescriptor],
        maxMessageBytes: Int = NativeProtocolV1.maxMessageBytes
    ) {
        self.hostInstanceID = hostInstanceID
        self.platform = platform
        self.backend = backend
        self.methods = methods
        self.maxMessageBytes = maxMessageBytes
    }

    public var jsonValue: NativeJSONValue {
        .object([
            "hostInstanceId": .string(hostInstanceID),
            "platform": .string(platform),
            "backend": .string(backend),
            "methods": .array(methods.map { method in
                .object([
                    "name": .string(method.name),
                    "intent": .string(method.intent.rawValue),
                    "scopeKinds": .array(method.scopeKinds.map(NativeJSONValue.string)),
                ])
            }),
            "maxMessageBytes": .number(Double(maxMessageBytes)),
        ])
    }
}
