import Foundation
import SurfaceLoomNativeProtocol

final class MacOSLateLaunchTicket: @unchecked Sendable {
    private enum State {
        case waiting
        case received(Result<MacOSApplicationIdentity, NativeHostBackendError>)
        case abandoned
        case claimed
    }

    let launchID: String
    private let condition = NSCondition()
    private var state: State = .waiting
    private let registry: MacOSOwnershipRegistry
    private let cleanup: @Sendable (MacOSApplicationIdentity) -> Bool

    init(
        launchID: String,
        registry: MacOSOwnershipRegistry,
        cleanup: @escaping @Sendable (MacOSApplicationIdentity) -> Bool
    ) {
        self.launchID = launchID
        self.registry = registry
        self.cleanup = cleanup
    }

    func receive(_ result: Result<MacOSApplicationIdentity, NativeHostBackendError>) {
        if case let .success(application) = result {
            registry.notePendingIdentity(launchID: launchID, application: application)
        }
        condition.lock()
        switch state {
        case .waiting:
            state = .received(result)
            condition.broadcast()
            condition.unlock()
        case .abandoned:
            state = .claimed
            condition.unlock()
            registry.cleanupLate(launchID: launchID, result: result, cleanup: cleanup)
        case .received, .claimed:
            condition.unlock()
        }
    }

    func wait(context: NativeHostExecutionContext) -> Result<MacOSApplicationIdentity, NativeHostBackendError>? {
        condition.lock()
        defer { condition.unlock() }
        while case .waiting = state {
            if context.isCancellationRequested || context.deadline.isExpired() { return nil }
            _ = condition.wait(until: Date().addingTimeInterval(0.02))
        }
        guard case let .received(result) = state else { return nil }
        return result
    }

    func claim() -> Result<MacOSApplicationIdentity, NativeHostBackendError>? {
        condition.lock()
        guard case let .received(result) = state else { condition.unlock(); return nil }
        state = .claimed
        condition.unlock()
        registry.claim(launchID: launchID, result: result)
        return result
    }

    func abandon() {
        condition.lock()
        switch state {
        case .waiting:
            state = .abandoned
            condition.unlock()
        case let .received(result):
            state = .claimed
            condition.unlock()
            registry.cleanupLate(launchID: launchID, result: result, cleanup: cleanup)
        case .abandoned, .claimed:
            condition.unlock()
        }
    }

    func cancelBeforeSubmission() {
        condition.lock()
        guard case .waiting = state else { condition.unlock(); return }
        state = .claimed
        condition.unlock()
        registry.cancelUnsubmitted(launchID: launchID)
    }
}
