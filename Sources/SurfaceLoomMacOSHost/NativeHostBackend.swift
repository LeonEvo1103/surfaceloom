import Foundation
import SurfaceLoomNativeProtocol

public struct NativeHostBackendCommand: @unchecked Sendable {
    private let executeBody: @Sendable () throws -> NativeJSONValue
    private let validateBody: @Sendable () throws -> Void
    private let cancelBody: @Sendable () -> Void
    private let responseExpiredBody: @Sendable () -> NativeOperationOutcome?

    public init(
        execute: @escaping @Sendable () throws -> NativeJSONValue,
        validateBeforeSubmission: @escaping @Sendable () throws -> Void = {},
        cancelBeforeSubmission: @escaping @Sendable () -> Void = {},
        responseExpired: @escaping @Sendable () -> NativeOperationOutcome? = { nil }
    ) {
        executeBody = execute
        validateBody = validateBeforeSubmission
        cancelBody = cancelBeforeSubmission
        responseExpiredBody = responseExpired
    }

    func execute() throws -> NativeJSONValue { try executeBody() }
    func validateBeforeSubmission() throws { try validateBody() }
    func cancelBeforeSubmission() { cancelBody() }
    func responseExpired() -> NativeOperationOutcome? { responseExpiredBody() }
}

public protocol NativeHostBackend: Sendable {
    var descriptor: NativeHostDescriptor { get }
    func prepare(
        request: NativeRequest,
        context: NativeHostExecutionContext
    ) throws -> NativeHostBackendCommand
    @discardableResult func shutdown() -> Bool
}

public extension NativeHostBackend {
    func shutdown() -> Bool { true }
}
