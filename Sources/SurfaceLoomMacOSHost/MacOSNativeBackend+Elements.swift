import Foundation
import SurfaceLoomNativeProtocol

extension MacOSNativeBackend {
    func prepareFind(
        _ scope: NativeScope,
        payload: NativeJSONObject,
        context: NativeHostExecutionContext
    ) throws -> NativeHostBackendCommand {
        try requireAccessibility()
        let spec = try MacOSPayload.locatorPayload(payload)
        let resolved = try scopedElement(scope)
        return NativeHostBackendCommand {
            let waitBudget = min(spec.timeoutMilliseconds, context.deadline.remainingMilliseconds())
            let end = DispatchTime.now().uptimeNanoseconds + UInt64(waitBudget) * 1_000_000
            var lastNotFound: NativeHostBackendError?
            repeat {
                try self.requireAXRunning(context)
                try self.requireCurrent(resolved.session.application)
                do {
                    let element = try self.platform.findUnique(
                        spec.locator, under: resolved.element,
                        application: resolved.session.application, context: context
                    )
                    let snapshot = try self.platform.snapshot(
                        element, application: resolved.session.application, context: context
                    )
                    let handleID = try self.registry.remember(
                        sessionID: resolved.session.sessionID, element: element
                    )
                    return self.elementJSON(
                        sessionID: resolved.session.sessionID,
                        handleID: handleID,
                        snapshot: snapshot
                    )
                } catch let error as NativeHostBackendError where error.code == "element_not_found" {
                    lastNotFound = error
                }
                if DispatchTime.now().uptimeNanoseconds >= end { break }
                let sleepMS = min(spec.pollIntervalMilliseconds, max(context.deadline.remainingMilliseconds(), 1))
                Thread.sleep(forTimeInterval: Double(sleepMS) / 1_000)
            } while !context.deadline.isExpired()
            if context.deadline.isExpired() {
                throw macOSBackendError("deadline_exceeded", .deadline,
                                        "The AX observation exceeded its request deadline.")
            }
            throw lastNotFound ?? macOSBackendError(
                "element_not_found", .notFound, "No AX element matched the strict locator."
            )
        }
    }

    func prepareGet(
        _ scope: NativeScope,
        context: NativeHostExecutionContext
    ) throws -> NativeHostBackendCommand {
        try requireAccessibility()
        let resolved = try scopedHandle(scope)
        return NativeHostBackendCommand {
            try self.requireAXRunning(context)
            try self.requireCurrent(resolved.session.application)
            let value = try self.platform.snapshot(
                resolved.element, application: resolved.session.application, context: context
            )
            return self.elementJSON(
                sessionID: resolved.session.sessionID,
                handleID: resolved.handleID,
                snapshot: value
            )
        }
    }

    func prepareAction(
        _ scope: NativeScope,
        payload: NativeJSONObject,
        context: NativeHostExecutionContext
    ) throws -> NativeHostBackendCommand {
        try requireAccessibility()
        let action = try MacOSPayload.action(payload)
        let target = try scopedHandle(scope)
        guard action.expectedProcessID == target.session.application.processID else {
            throw targetChanged()
        }
        let (_, expectedRoot) = try registry.handle(
            sessionID: target.session.sessionID,
            handleID: action.expectedRootHandleID
        )
        let validated = MacOSActionTargetBox()
        return NativeHostBackendCommand(execute: {
            guard let current = validated.take() else {
                throw macOSBackendError("action_target_unvalidated", .internal,
                                        "The AX action target was not validated for submission.")
            }
            try self.platform.perform(
                action.action, value: action.value, on: current, context: context
            )
            return .object([
                "action": .string(action.action.rawValue),
                "completed": .bool(true),
            ])
        }, validateBeforeSubmission: {
            try self.requireAXRunning(context)
            try self.requireCurrent(target.session.application)
            let current = try self.platform.findUnique(
                action.expectedLocator, under: expectedRoot,
                application: target.session.application, context: context
            )
            guard self.platform.sameElement(current, target.element) else { throw self.targetChanged() }
            try self.platform.validateAction(action.action, on: current, context: context)
            try self.requireAXRunning(context)
            try self.requireCurrent(target.session.application)
            validated.store(current)
        })
    }

    private func scopedElement(
        _ scope: NativeScope
    ) throws -> (session: MacOSSessionRecord, element: MacOSHostElement) {
        switch scope {
        case let .session(_, sessionID):
            let session = try registry.session(sessionID)
            let (_, root) = try registry.handle(sessionID: sessionID, handleID: session.rootHandleID)
            return (session, root)
        case let .handle(_, sessionID, handleID):
            return try registry.handle(sessionID: sessionID, handleID: handleID)
        default:
            throw MacOSPayload.invalid()
        }
    }

    private func scopedHandle(
        _ scope: NativeScope
    ) throws -> (session: MacOSSessionRecord, element: MacOSHostElement, handleID: String) {
        guard case let .handle(_, sessionID, handleID) = scope else { throw MacOSPayload.invalid() }
        let (session, element) = try registry.handle(sessionID: sessionID, handleID: handleID)
        return (session, element, handleID)
    }

    private func elementJSON(
        sessionID: String,
        handleID: String,
        snapshot: MacOSAXSnapshot
    ) -> NativeJSONValue {
        .object([
            "handle": handleJSON(sessionID: sessionID, handleID: handleID),
            "snapshot": snapshot.jsonValue,
        ])
    }

    private func requireAXRunning(_ context: NativeHostExecutionContext) throws {
        if context.isCancellationRequested {
            throw macOSBackendError("request_cancelled", .cancelled, "The AX request was cancelled.")
        }
        if context.deadline.isExpired() {
            throw macOSBackendError("deadline_exceeded", .deadline, "The AX request exceeded its deadline.")
        }
    }

    private func requireCurrent(_ application: MacOSApplicationIdentity) throws {
        switch platform.identityStatus(application) {
        case .current: return
        case .provenStopped: throw staleSession()
        case .unconfirmed:
            throw macOSBackendError("application_identity_unconfirmed", .backend,
                                    "The application identity could not be revalidated.")
        }
    }

    private func staleSession() -> NativeHostBackendError {
        macOSBackendError("session_stale", .notFound,
                          "The application identity for this session is no longer current.")
    }
    private func targetChanged() -> NativeHostBackendError {
        macOSBackendError("action_target_changed", .conflict,
                          "The checked AX target changed before submission.")
    }
}

private final class MacOSActionTargetBox: @unchecked Sendable {
    private let lock = NSLock()
    private var element: MacOSHostElement?
    func store(_ element: MacOSHostElement) { lock.withLock { self.element = element } }
    func take() -> MacOSHostElement? { lock.withLock { defer { element = nil }; return element } }
}
