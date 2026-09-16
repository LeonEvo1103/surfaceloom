import Foundation

public enum FixtureLifecycleState: String, Sendable {
    case ready
    case closing
}

public struct FixtureSnapshot: Equatable, Sendable {
    public let invokeCount: Int
    public let inputValue: String
    public let ambiguousInvocationCount: Int
    public let transientVisible: Bool
    public let lifecycleState: FixtureLifecycleState
}

public final class FixtureState: @unchecked Sendable {
    private let lock = NSLock()
    private var invokeCount = 0
    private var inputValue = ""
    private var ambiguousInvocationCount = 0
    private var transientVisible = true
    private var lifecycleState = FixtureLifecycleState.ready

    public init() {}

    @discardableResult
    public func recordInvoke() -> Int {
        lock.withLock {
            invokeCount += 1
            return invokeCount
        }
    }

    public func setValue(_ value: String) {
        lock.withLock {
            inputValue = value
        }
    }

    @discardableResult
    public func recordAmbiguousInvocation() -> Int {
        lock.withLock {
            ambiguousInvocationCount += 1
            return ambiguousInvocationCount
        }
    }

    @discardableResult
    public func dismissTransient() -> Bool {
        lock.withLock {
            guard transientVisible else { return false }
            transientVisible = false
            return true
        }
    }

    @discardableResult
    public func restoreTransient() -> Bool {
        lock.withLock {
            guard !transientVisible else { return false }
            transientVisible = true
            return true
        }
    }

    public func beginClosing() {
        lock.withLock {
            lifecycleState = .closing
        }
    }

    public func snapshot() -> FixtureSnapshot {
        lock.withLock {
            FixtureSnapshot(
                invokeCount: invokeCount,
                inputValue: inputValue,
                ambiguousInvocationCount: ambiguousInvocationCount,
                transientVisible: transientVisible,
                lifecycleState: lifecycleState
            )
        }
    }
}
