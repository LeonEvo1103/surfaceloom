import Foundation
import SurfaceLoomNativeProtocol

struct MacOSSessionRecord: @unchecked Sendable {
    let sessionID: String
    let responsibilityID: String?
    let ownership: MacOSSessionOwnership
    let application: MacOSApplicationIdentity
    let rootHandleID: String
    var handles: [String: MacOSHostElement]
}

struct MacOSLateCleanupEvidence: Equatable, Sendable {
    let launchID: String
    let processID: Int32?
    let attempted: Bool
    let stopped: Bool
    let incomplete: Bool
    let reason: String
}

final class MacOSOwnershipRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var sessions: [String: MacOSSessionRecord] = [:]
    private var pending: [String: MacOSLateLaunchTicket] = [:]
    private var pendingIdentities: [String: MacOSApplicationIdentity] = [:]
    private var unresolved: [String: MacOSApplicationIdentity] = [:]
    private var activeCleanupResponsibilities = Set<String>()
    private var protectedConflicts: [String: MacOSApplicationIdentity] = [:]
    private var unconfirmedLaunches = Set<String>()
    private var handleCount = 0
    private var evidence: [MacOSLateCleanupEvidence] = []
    private var evidenceOverflowed = false
    private let maximumEntries = 10_000

    func makeLateLaunch(cleanup: @escaping @Sendable (MacOSApplicationIdentity) -> Bool) throws -> MacOSLateLaunchTicket {
        let launchID = opaqueID("launch")
        let ticket = MacOSLateLaunchTicket(launchID: launchID, registry: self, cleanup: cleanup)
        try lock.withLock {
            guard responsibilityCountLocked() < maximumEntries else { throw registryFull() }
            pending[launchID] = ticket
        }
        return ticket
    }

    func register(
        application: MacOSApplicationIdentity,
        ownership: MacOSSessionOwnership,
        root: MacOSHostElement,
        launchID: String? = nil
    ) throws -> MacOSSessionRecord {
        try lock.withLock {
            let replacesReservation = launchID.map {
                unresolved[$0] != nil || protectedConflicts[$0] != nil || unconfirmedLaunches.contains($0)
            } ?? false
            guard responsibilityCountLocked() - (replacesReservation ? 1 : 0) < maximumEntries,
                  handleCount < maximumEntries else { throw registryFull() }
            guard !sessions.values.contains(where: { $0.application == application }),
                  !unresolved.contains(where: { $0.key != launchID && $0.value == application }),
                  !protectedConflicts.contains(where: { $0.key != launchID && $0.value == application }),
                  !pendingIdentities.contains(where: { $0.key != launchID && $0.value == application }) else {
                throw conflict()
            }
            let sessionID = opaqueID("session")
            let rootID = opaqueID("handle")
            let responsibilityID = ownership == .owned ? (launchID ?? "owned-\(sessionID)") : nil
            let record = MacOSSessionRecord(
                sessionID: sessionID, responsibilityID: responsibilityID,
                ownership: ownership, application: application,
                rootHandleID: rootID, handles: [rootID: root]
            )
            sessions[sessionID] = record
            handleCount += 1
            if let launchID {
                unresolved.removeValue(forKey: launchID)
                protectedConflicts.removeValue(forKey: launchID)
                unconfirmedLaunches.remove(launchID)
            }
            return record
        }
    }

    func session(_ sessionID: String) throws -> MacOSSessionRecord {
        try lock.withLock {
            guard let record = sessions[sessionID] else {
                throw macOSBackendError("session_not_found", .notFound, "The native session is not active.")
            }
            return record
        }
    }

    func handle(sessionID: String, handleID: String) throws -> (MacOSSessionRecord, MacOSHostElement) {
        try lock.withLock {
            guard let session = sessions[sessionID] else {
                throw macOSBackendError("session_not_found", .notFound, "The native session is not active.")
            }
            guard let handle = session.handles[handleID] else {
                throw macOSBackendError("element_handle_unknown", .notFound, "The handle is not active in this session.")
            }
            return (session, handle)
        }
    }

    func remember(sessionID: String, element: MacOSHostElement) throws -> String {
        try lock.withLock {
            guard var session = sessions[sessionID] else {
                throw macOSBackendError("session_not_found", .notFound, "The native session is not active.")
            }
            guard handleCount < maximumEntries else { throw registryFull() }
            let handleID = opaqueID("handle")
            session.handles[handleID] = element
            sessions[sessionID] = session
            handleCount += 1
            return handleID
        }
    }

    @discardableResult
    func removeSession(_ sessionID: String) -> MacOSSessionRecord? {
        lock.withLock {
            let removed = sessions.removeValue(forKey: sessionID)
            if let removed { handleCount -= removed.handles.count }
            return removed
        }
    }

    func notePendingIdentity(launchID: String, application: MacOSApplicationIdentity) {
        lock.withLock {
            guard pending[launchID] != nil else { return }
            pendingIdentities[launchID] = application
        }
    }

    func claim(launchID: String, result: Result<MacOSApplicationIdentity, NativeHostBackendError>) {
        lock.withLock {
            pending.removeValue(forKey: launchID)
            pendingIdentities.removeValue(forKey: launchID)
            switch result {
            case let .success(application): unresolved[launchID] = application
            case let .failure(error) where error.code == "launch_identity_unconfirmed":
                retainUnconfirmedLocked(launchID: launchID, reason: error.code)
            case let .failure(error):
                appendEvidenceLocked(.init(
                    launchID: launchID, processID: nil, attempted: false, stopped: false,
                    incomplete: false, reason: error.code
                ))
            }
        }
    }

    func cancelUnsubmitted(launchID: String) {
        lock.withLock {
            pending.removeValue(forKey: launchID)
            pendingIdentities.removeValue(forKey: launchID)
        }
    }

    func cleanupLate(
        launchID: String,
        result: Result<MacOSApplicationIdentity, NativeHostBackendError>,
        cleanup: (MacOSApplicationIdentity) -> Bool
    ) {
        guard case let .success(application) = result else {
            claim(launchID: launchID, result: result)
            return
        }
        let allowed = lock.withLock { () -> Bool in
            guard !activeCleanupResponsibilities.contains(launchID) else { return false }
            let protected = sessions.values.contains { $0.application == application }
                || unresolved.contains { $0.key != launchID && $0.value == application }
                || protectedConflicts.contains { $0.key != launchID && $0.value == application }
            guard !protected else {
                unresolved.removeValue(forKey: launchID)
                protectedConflicts[launchID] = application
                appendEvidenceLocked(.init(
                    launchID: launchID, processID: application.processID,
                    attempted: false, stopped: false, incomplete: true,
                    reason: "identity_protected_by_existing_responsibility"
                ))
                pending.removeValue(forKey: launchID)
                pendingIdentities.removeValue(forKey: launchID)
                return false
            }
            unresolved[launchID] = application
            activeCleanupResponsibilities.insert(launchID)
            return true
        }
        guard allowed else { return }
        let stopped = cleanup(application)
        recordCleanup(launchID: launchID, application: application, stopped: stopped)
        if stopped { resolveUnresolved(launchID) }
        finishCleanupAttempt(launchID)
        finishLateCleanup(launchID)
    }

    func mayCleanup(
        launchID: String,
        application: MacOSApplicationIdentity,
        excludingSessionID: String?
    ) -> Bool {
        lock.withLock {
            guard !activeCleanupResponsibilities.contains(launchID) else { return false }
            let protectedSession = sessions.values.contains {
                $0.application == application && $0.sessionID != excludingSessionID
            }
            let protectedUnresolved = unresolved.contains {
                $0.key != launchID && $0.value == application
            } || protectedConflicts.contains {
                $0.key != launchID && $0.value == application
            }
            guard !protectedSession, !protectedUnresolved else {
                unresolved.removeValue(forKey: launchID)
                protectedConflicts[launchID] = application
                appendEvidenceLocked(.init(
                    launchID: launchID, processID: application.processID,
                    attempted: false, stopped: false, incomplete: true,
                    reason: "identity_protected_by_existing_responsibility"
                ))
                return false
            }
            unresolved[launchID] = application
            activeCleanupResponsibilities.insert(launchID)
            return true
        }
    }

    func recordCleanup(launchID: String, application: MacOSApplicationIdentity, stopped: Bool) {
        lock.withLock {
            appendEvidenceLocked(.init(
                launchID: launchID, processID: application.processID,
                attempted: true, stopped: stopped, incomplete: !stopped,
                reason: stopped ? "proven_stopped" : "cleanup_unconfirmed"
            ))
        }
    }

    func finishCleanupAttempt(_ launchID: String) {
        _ = lock.withLock { activeCleanupResponsibilities.remove(launchID) }
    }

    func retainUnresolved(launchID: String, application: MacOSApplicationIdentity) {
        lock.withLock { unresolved[launchID] = application }
    }
    func resolveUnresolved(_ launchID: String) {
        _ = lock.withLock { unresolved.removeValue(forKey: launchID) }
    }
    private func finishLateCleanup(_ launchID: String) {
        lock.withLock {
            pending.removeValue(forKey: launchID)
            pendingIdentities.removeValue(forKey: launchID)
        }
    }
    func abandonPendingForShutdown() {
        let tickets = lock.withLock { Array(pending.values) }
        tickets.forEach { $0.abandon() }
    }

    func waitForPendingReceivers() {
        // Each wait is bounded so the main run loop remains serviceable. The host
        // intentionally stays alive until every submitted launch receiver is terminal.
        while pendingLaunchCount() > 0 {
            Thread.sleep(forTimeInterval: 0.02)
        }
    }

    func hasIncompleteResponsibility() -> Bool {
        lock.withLock {
            sessions.values.contains { $0.ownership == .owned }
                || !pending.isEmpty || !unresolved.isEmpty
                || !protectedConflicts.isEmpty || !unconfirmedLaunches.isEmpty
        }
    }

    func evidenceSnapshot() -> [MacOSLateCleanupEvidence] { lock.withLock { evidence } }
    func activeSessionCount() -> Int { lock.withLock { sessions.count } }
    func pendingLaunchCount() -> Int { lock.withLock { pending.count } }
    func unconfirmedResponsibilityCount() -> Int {
        lock.withLock {
            unresolved.count + protectedConflicts.count + unconfirmedLaunches.count + pending.count
        }
    }
    func sessionsSnapshot() -> [MacOSSessionRecord] { lock.withLock { Array(sessions.values) } }
    func unresolvedSnapshot() -> [(String, MacOSApplicationIdentity)] {
        lock.withLock { unresolved.map { ($0.key, $0.value) } }
    }
    func contains(application: MacOSApplicationIdentity) -> Bool {
        lock.withLock {
            sessions.values.contains { $0.application == application }
                || unresolved.values.contains(application)
                || protectedConflicts.values.contains(application)
                || pendingIdentities.values.contains(application)
        }
    }

    private func retainUnconfirmedLocked(launchID: String, reason: String) {
        unconfirmedLaunches.insert(launchID)
        appendEvidenceLocked(.init(
            launchID: launchID, processID: nil, attempted: false, stopped: false,
            incomplete: true, reason: reason
        ))
    }

    private func appendEvidenceLocked(_ item: MacOSLateCleanupEvidence) {
        guard evidence.count < maximumEntries else {
            guard !evidenceOverflowed else { return }
            evidenceOverflowed = true
            evidence[maximumEntries - 1] = .init(
                launchID: "evidence-overflow", processID: nil, attempted: false,
                stopped: false, incomplete: true, reason: "cleanup_evidence_overflow"
            )
            return
        }
        evidence.append(item)
    }

    private func responsibilityCountLocked() -> Int {
        sessions.count + pending.count + unresolved.count
            + protectedConflicts.count + unconfirmedLaunches.count
    }
    private func opaqueID(_ prefix: String) -> String { "\(prefix)-\(UUID().uuidString.lowercased())" }
    private func registryFull() -> NativeHostBackendError {
        macOSBackendError("ownership_registry_full", .conflict, "The macOS ownership registry reached its safety limit.")
    }
    private func conflict() -> NativeHostBackendError {
        macOSBackendError("application_already_registered", .conflict,
                          "The application identity already belongs to an active responsibility.")
    }
}
