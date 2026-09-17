import Foundation
import SurfaceLoomNativeProtocol

public struct NativeHostBackendError: Error, Sendable {
    public let code: String
    public let category: NativeErrorCategory
    public let safeMessage: String

    public init(code: String, category: NativeErrorCategory, safeMessage: String) {
        self.code = code
        self.category = category
        self.safeMessage = safeMessage
    }
}

public final class NativePreparedRequest: @unchecked Sendable {
    public let request: NativeRequest
    public let deadline: NativeHostDeadline
    let cancellation: NativeCancellationState
    private let hookLock = NSLock()
    private var responseExpiredHook: (@Sendable () -> NativeOperationOutcome?)?

    init(request: NativeRequest, receivedUptimeNanoseconds: UInt64, cancellation: NativeCancellationState) {
        self.request = request
        deadline = NativeHostDeadline(
            receivedUptimeNanoseconds: receivedUptimeNanoseconds,
            timeoutMilliseconds: request.timeoutMilliseconds
        )
        self.cancellation = cancellation
    }

    func setResponseExpiredHook(_ hook: @escaping @Sendable () -> NativeOperationOutcome?) {
        hookLock.withLock { responseExpiredHook = hook }
    }

    func handleResponseExpired() -> NativeOperationOutcome? {
        let hook = hookLock.withLock {
            defer { responseExpiredHook = nil }
            return responseExpiredHook
        }
        return hook?()
    }
}
