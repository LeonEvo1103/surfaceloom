import Foundation

public struct NativeHostDeadline: Sendable {
    public let receivedUptimeNanoseconds: UInt64
    public let timeoutMilliseconds: Int

    public init(receivedUptimeNanoseconds: UInt64, timeoutMilliseconds: Int) {
        self.receivedUptimeNanoseconds = receivedUptimeNanoseconds
        self.timeoutMilliseconds = timeoutMilliseconds
    }

    public func isExpired(nowUptimeNanoseconds: UInt64 = DispatchTime.now().uptimeNanoseconds) -> Bool {
        remainingMilliseconds(nowUptimeNanoseconds: nowUptimeNanoseconds) == 0
    }

    public func remainingMilliseconds(
        nowUptimeNanoseconds: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) -> Int {
        guard timeoutMilliseconds > 0 else { return 0 }
        let elapsed = nowUptimeNanoseconds >= receivedUptimeNanoseconds
            ? nowUptimeNanoseconds - receivedUptimeNanoseconds : 0
        let budget = UInt64(timeoutMilliseconds) * 1_000_000
        guard elapsed < budget else { return 0 }
        return Int((budget - elapsed + 999_999) / 1_000_000)
    }
}

final class NativeCancellationState: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }
}

public struct NativeHostExecutionContext: Sendable {
    private let cancellation: NativeCancellationState
    public let deadline: NativeHostDeadline

    init(cancellation: NativeCancellationState, deadline: NativeHostDeadline) {
        self.cancellation = cancellation
        self.deadline = deadline
    }

    /// Cooperative signal only. A non-cooperative handler is not forcibly stopped,
    /// and cancellation/deadline/EOF therefore cannot prove cleanup or termination.
    public var isCancellationRequested: Bool { cancellation.isCancelled }
}
