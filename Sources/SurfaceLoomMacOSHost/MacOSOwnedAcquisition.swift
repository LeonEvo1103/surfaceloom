import Foundation

final class MacOSOwnedAcquisition: @unchecked Sendable {
    struct Value {
        let launchID: String
        let application: MacOSApplicationIdentity
        let sessionID: String?
    }

    private let lock = NSLock()
    private var value: Value?
    private var cleanupStarted = false

    func claim(launchID: String, application: MacOSApplicationIdentity) {
        lock.withLock { value = Value(launchID: launchID, application: application, sessionID: nil) }
    }

    func registered(_ session: MacOSSessionRecord) {
        lock.withLock {
            guard let value else { return }
            self.value = Value(
                launchID: value.launchID,
                application: value.application,
                sessionID: session.sessionID
            )
        }
    }

    func beginCleanup() -> Value? {
        lock.withLock {
            guard !cleanupStarted, let value else { return nil }
            cleanupStarted = true
            return value
        }
    }
}

final class MacOSBorrowedAcquisition: @unchecked Sendable {
    private let lock = NSLock()
    private var sessionID: String?
    func store(_ sessionID: String) { lock.withLock { self.sessionID = sessionID } }
    func take() -> String? {
        lock.withLock {
            defer { sessionID = nil }
            return sessionID
        }
    }
}
