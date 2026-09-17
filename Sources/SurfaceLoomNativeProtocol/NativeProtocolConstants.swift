import Foundation

public enum NativeProtocolV1 {
    public static let name = "surfaceloom.native"
    public static let version = "1.0"
    public static let maxMessageBytes = 1_048_576
    public static let maxDeadlineMilliseconds = 120_000
}

public struct NativeProtocolError: Error, Equatable, Sendable {
    public let code: String
    public let category: NativeErrorCategory
    public let message: String
    public let requestID: String?

    public init(
        code: String,
        category: NativeErrorCategory = .protocolError,
        message: String,
        requestID: String? = nil
    ) {
        self.code = code
        self.category = category
        self.message = message
        self.requestID = requestID
    }
}

public enum NativeOperationIntent: String, Sendable {
    case observe
    case mutate
    case lifecycle
}

public enum NativeOperationOutcome: String, Sendable {
    case notExecuted
    case executed
    case unknown
}

public enum NativeErrorCategory: String, Sendable {
    case protocolError = "protocol"
    case invalidRequest
    case unsupported
    case notFound
    case permissionDenied
    case deadline
    case cancelled
    case conflict
    case backend
    case `internal`
}

public enum NativeRetryDisposition: String, Sendable {
    case never
    case safe
}

public enum NativeCancellationReason: String, Sendable {
    case caller
    case deadline
    case shutdown
}
