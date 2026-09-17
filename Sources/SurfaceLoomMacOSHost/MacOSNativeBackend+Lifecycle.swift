import Foundation
import SurfaceLoomNativeProtocol

extension MacOSNativeBackend {
    func shutdown() -> Bool {
        let known = registry.sessionsSnapshot()
        let unresolvedAtEntry = registry.unresolvedSnapshot()
        let ownedResponsibilityIDs = Set(known.compactMap { session in
            session.ownership == .owned ? session.responsibilityID : nil
        })
        for session in known where session.ownership == .borrowed {
            _ = registry.removeSession(session.sessionID)
        }
        for session in known where session.ownership == .owned {
            cleanupKnownOwned(
                launchID: session.responsibilityID ?? "owned-\(session.sessionID)",
                session: session,
                timeoutMilliseconds: 1_000
            )
        }
        for (launchID, application) in unresolvedAtEntry where !ownedResponsibilityIDs.contains(launchID) {
            cleanupUnresolved(launchID: launchID, application: application, timeoutMilliseconds: 1_000)
        }
        // A receiver remains registered, but can no longer starve cleanup of known resources.
        registry.abandonPendingForShutdown()
        registry.waitForPendingReceivers()
        return !registry.hasIncompleteResponsibility()
    }

    func prepareLaunch(
        _ payload: NativeJSONObject,
        context: NativeHostExecutionContext
    ) throws -> NativeHostBackendCommand {
        try requireAccessibility()
        let spec = try MacOSPayload.launch(payload)
        try platform.validateLaunch(spec)
        let ticket = try registry.makeLateLaunch { [platform] application in
            platform.terminate(application, force: true, timeoutMilliseconds: 5_000)
        }
        let acquisition = MacOSOwnedAcquisition()
        return NativeHostBackendCommand(execute: {
            self.platform.beginLaunch(spec) { ticket.receive($0) }
            guard ticket.wait(context: context) != nil else {
                ticket.abandon()
                throw self.stoppedError(context)
            }
            if context.isCancellationRequested || context.deadline.isExpired() {
                ticket.abandon()
                throw self.stoppedError(context)
            }
            guard let result = ticket.claim() else {
                throw macOSBackendError("launch_result_unavailable")
            }
            let application = try result.get()
            acquisition.claim(launchID: ticket.launchID, application: application)
            do {
                try self.requireRunning(context)
                let root = try self.platform.rootElement(for: application)
                try self.requireRunning(context)
                let session = try self.registry.register(
                    application: application, ownership: .owned,
                    root: root, launchID: ticket.launchID
                )
                acquisition.registered(session)
                try self.requireRunning(context)
                return self.sessionJSON(session)
            } catch {
                _ = self.cleanup(acquisition, timeoutMilliseconds: context.deadline.remainingMilliseconds())
                throw error
            }
        }, cancelBeforeSubmission: {
            ticket.cancelBeforeSubmission()
        }, responseExpired: {
            self.cleanup(acquisition, timeoutMilliseconds: 5_000)
        })
    }

    func prepareAttach(_ payload: NativeJSONObject) throws -> NativeHostBackendCommand {
        try requireAccessibility()
        let processID = try MacOSPayload.attach(payload)
        let application = try platform.attach(processID: processID)
        guard !registry.contains(application: application) else { throw applicationConflict() }
        let root = try platform.rootElement(for: application)
        let acquisition = MacOSBorrowedAcquisition()
        return NativeHostBackendCommand(execute: {
            let session = try self.registry.register(
                application: application, ownership: .borrowed, root: root
            )
            acquisition.store(session.sessionID)
            return self.sessionJSON(session)
        }, responseExpired: {
            guard let sessionID = acquisition.take() else { return nil }
            _ = self.registry.removeSession(sessionID)
            return .unknown
        })
    }

    func prepareRelease(_ scope: NativeScope) throws -> NativeHostBackendCommand {
        let session = try registry.session(try sessionID(scope))
        if session.ownership == .owned {
            switch platform.identityStatus(session.application) {
            case .current, .unconfirmed:
                throw macOSBackendError("ownership_cleanup_required", .permissionDenied,
                                        "An owned session requires proven cleanup before release.")
            case .provenStopped: break
            }
        }
        return NativeHostBackendCommand {
            guard self.registry.removeSession(session.sessionID) != nil else {
                throw macOSBackendError("session_not_found", .notFound, "The native session is not active.")
            }
            return .object(["released": .bool(true), "sessionId": .string(session.sessionID)])
        }
    }

    func prepareTerminate(
        _ scope: NativeScope,
        context: NativeHostExecutionContext
    ) throws -> NativeHostBackendCommand {
        let session = try registry.session(try sessionID(scope))
        guard session.ownership == .owned else {
            throw macOSBackendError("ownership_required", .permissionDenied,
                                    "This lifecycle action requires an owned session.")
        }
        return NativeHostBackendCommand {
            let stopped = self.platform.terminate(
                session.application, force: true,
                timeoutMilliseconds: context.deadline.remainingMilliseconds()
            )
            self.registry.recordCleanup(
                launchID: "terminate", application: session.application, stopped: stopped
            )
            guard stopped else {
                throw macOSBackendError("termination_unconfirmed", .backend,
                                        "The owned application could not be proven stopped.")
            }
            _ = self.registry.removeSession(session.sessionID)
            return .object([
                "sessionId": .string(session.sessionID),
                "processId": .number(Double(session.application.processID)),
                "stopped": .bool(true),
            ])
        }
    }

    private func cleanup(_ acquisition: MacOSOwnedAcquisition, timeoutMilliseconds: Int) -> NativeOperationOutcome? {
        guard let value = acquisition.beginCleanup() else { return nil }
        guard registry.mayCleanup(
            launchID: value.launchID, application: value.application,
            excludingSessionID: value.sessionID
        ) else { return .unknown }
        let stopped = platform.terminate(
            value.application, force: true,
            timeoutMilliseconds: min(max(timeoutMilliseconds, 0), 5_000)
        )
        registry.recordCleanup(launchID: value.launchID, application: value.application, stopped: stopped)
        if stopped {
            if let sessionID = value.sessionID { _ = registry.removeSession(sessionID) }
            registry.resolveUnresolved(value.launchID)
        }
        registry.finishCleanupAttempt(value.launchID)
        return .unknown
    }

    private func cleanupKnownOwned(launchID: String, session: MacOSSessionRecord, timeoutMilliseconds: Int) {
        guard registry.mayCleanup(
            launchID: launchID, application: session.application,
            excludingSessionID: session.sessionID
        ) else { return }
        let stopped = platform.terminate(
            session.application, force: true, timeoutMilliseconds: timeoutMilliseconds
        )
        registry.recordCleanup(launchID: launchID, application: session.application, stopped: stopped)
        if stopped {
            _ = registry.removeSession(session.sessionID)
            registry.resolveUnresolved(launchID)
        }
        registry.finishCleanupAttempt(launchID)
    }

    private func cleanupUnresolved(
        launchID: String,
        application: MacOSApplicationIdentity,
        timeoutMilliseconds: Int
    ) {
        guard registry.mayCleanup(
            launchID: launchID, application: application, excludingSessionID: nil
        ) else { return }
        let stopped = platform.terminate(
            application, force: true, timeoutMilliseconds: timeoutMilliseconds
        )
        registry.recordCleanup(launchID: launchID, application: application, stopped: stopped)
        if stopped { registry.resolveUnresolved(launchID) }
        registry.finishCleanupAttempt(launchID)
    }

    private func requireRunning(_ context: NativeHostExecutionContext) throws {
        if context.isCancellationRequested {
            throw macOSBackendError("request_cancelled", .cancelled, "The submitted launch was cancelled.")
        }
        if context.deadline.isExpired() {
            throw macOSBackendError("deadline_exceeded", .deadline, "The submitted launch exceeded its deadline.")
        }
    }

    private func stoppedError(_ context: NativeHostExecutionContext) -> NativeHostBackendError {
        context.isCancellationRequested
            ? macOSBackendError("request_cancelled", .cancelled, "The submitted launch was cancelled.")
            : macOSBackendError("deadline_exceeded", .deadline, "The submitted launch exceeded its deadline.")
    }

    private func applicationConflict() -> NativeHostBackendError {
        macOSBackendError("application_already_registered", .conflict,
                          "The application identity already belongs to an active responsibility.")
    }
}
