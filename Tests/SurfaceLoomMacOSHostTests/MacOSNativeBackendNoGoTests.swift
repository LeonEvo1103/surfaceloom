import Foundation
import Testing
import SurfaceLoomNativeProtocol
@testable import SurfaceLoomMacOSHost

@Suite("macOS backend adversarial ownership and AX boundaries")
struct MacOSNativeBackendNoGoTests {
    let support = NativeHostContractTests()

    @Test("Late owned receiver never terminates a protected borrowed identity")
    func borrowedConflict() throws {
        let registry = MacOSOwnershipRegistry()
        let platform = FakeMacOSHostPlatform()
        let borrowed = try registry.register(
            application: platform.application, ownership: .borrowed,
            root: MacOSHostElement(raw: platform.root)
        )
        let ticket = try registry.makeLateLaunch { _ in
            Issue.record("protected borrowed identity was terminated")
            return true
        }
        ticket.abandon()
        ticket.receive(.success(platform.application))
        #expect(try registry.session(borrowed.sessionID).ownership == .borrowed)
        #expect(registry.unresolvedSnapshot().isEmpty)
        #expect(registry.unconfirmedResponsibilityCount() == 1)
        #expect(registry.evidenceSnapshot().last?.attempted == false)
        #expect(registry.evidenceSnapshot().last?.incomplete == true)
        _ = registry.removeSession(borrowed.sessionID)
        _ = MacOSNativeBackend(platform: platform, registry: registry).shutdown()
        #expect(platform.terminateCalls == 0)
    }

    @Test("Attach is rejected while a pending launch reserves the identity")
    func pendingIdentityBlocksAttach() throws {
        let platform = FakeMacOSHostPlatform()
        let registry = MacOSOwnershipRegistry()
        let backend = MacOSNativeBackend(
            hostInstanceID: "pending-identity", platform: platform, registry: registry
        )
        let ticket = try registry.makeLateLaunch { _ in true }
        ticket.receive(.success(platform.application))
        let response = try support.execute(NativeHostDispatcher(backend: backend), support.call(
            id: "attach-pending", method: "session.attach", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: ["processId": .number(Double(platform.application.processID))],
            operationID: "operation-attach-pending"
        ))
        #expect(response.error?.code == "application_already_registered")
        #expect(response.operation?.outcome == .notExecuted)
        #expect(registry.activeSessionCount() == 0)
        ticket.abandon()
    }

    @Test("Shutdown cleans known owned resources before abandoning pending receiver")
    func ownedAndPendingShutdown() throws {
        let platform = FakeMacOSHostPlatform()
        let registry = MacOSOwnershipRegistry()
        let backend = MacOSNativeBackend(platform: platform, registry: registry)
        _ = try registry.register(
            application: platform.application, ownership: .owned,
            root: MacOSHostElement(raw: platform.root)
        )
        let unresolved = MacOSApplicationIdentity(
            processID: 4_243, startSeconds: 101, startMicroseconds: 3,
            bundleIdentifier: "test.unresolved"
        )
        registry.retainUnresolved(launchID: "old-unresolved", application: unresolved)
        let ticket = try registry.makeLateLaunch { _ in true }
        let completion = DispatchSemaphore(value: 0)
        let shutdownResult = NativeHostContractTests.LockedInt()
        DispatchQueue.global().async {
            shutdownResult.set(backend.shutdown() ? 1 : 0)
            completion.signal()
        }
        let waitDeadline = Date().addingTimeInterval(2)
        while platform.lock.withLock({ platform.terminateCalls }) < 2, Date() < waitDeadline {
            Thread.sleep(forTimeInterval: 0.001)
        }
        #expect(platform.terminateCalls == 2)
        #expect(platform.terminatedProcessIDs == [platform.application.processID, unresolved.processID])
        #expect(registry.activeSessionCount() == 0)
        #expect(registry.unresolvedSnapshot().count == 1)
        #expect(registry.pendingLaunchCount() == 1)
        #expect(completion.wait(timeout: .now()) == .timedOut)
        ticket.receive(.success(platform.application))
        #expect(completion.wait(timeout: .now() + 2) == .success)
        #expect(shutdownResult.value == 0)
    }

    @Test("Cancellation at root acquisition performs one owned cleanup")
    func cancelAtRoot() throws {
        let platform = FakeMacOSHostPlatform()
        let backend = MacOSNativeBackend(hostInstanceID: "root-cancel", platform: platform)
        let dispatcher = NativeHostDispatcher(backend: backend)
        platform.onBeginLaunch = { platform.completeLaunch() }
        platform.onRoot = {
            dispatcher.cancel(NativeCancel(id: "cancel-root", requestID: "launch-root", reason: .caller))
        }
        let response = try support.execute(dispatcher, support.call(
            id: "launch-root", method: "session.launch", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: launchPayload(), operationID: "operation-root"
        ))
        #expect(response.error?.code == "request_cancelled")
        #expect(response.operation?.outcome == .unknown)
        #expect(platform.terminateCalls == 1)
        #expect(backend.registry.activeSessionCount() == 0)
    }

    @Test("Missing launch identity retains responsibility without termination")
    func missingLaunchIdentity() throws {
        let platform = FakeMacOSHostPlatform()
        let backend = MacOSNativeBackend(hostInstanceID: "identity-missing", platform: platform)
        platform.onBeginLaunch = {
            platform.completeLaunch(.failure(macOSBackendError("launch_identity_unconfirmed", .backend)))
        }
        let response = try support.execute(NativeHostDispatcher(backend: backend), support.call(
            id: "launch-missing", method: "session.launch", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: launchPayload(), operationID: "operation-missing"
        ))
        #expect(response.error?.code == "launch_identity_unconfirmed")
        #expect(response.operation?.outcome == .unknown)
        #expect(platform.terminateCalls == 0)
        #expect(backend.registry.pendingLaunchCount() == 0)
        #expect(backend.registry.unconfirmedResponsibilityCount() == 1)
    }

    @Test("Identity probe failures do not become stopped or release ownership")
    func identityUnconfirmed() throws {
        let platform = FakeMacOSHostPlatform()
        platform.attachError = macOSBackendError("application_identity_unconfirmed", .backend)
        let backend = MacOSNativeBackend(hostInstanceID: "identity-probe", platform: platform)
        let dispatcher = NativeHostDispatcher(backend: backend)
        let attach = try support.execute(dispatcher, support.call(
            id: "attach-unconfirmed", method: "session.attach", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: ["processId": .number(Double(platform.application.processID))],
            operationID: "operation-attach-unconfirmed"
        ))
        #expect(attach.error?.code == "application_identity_unconfirmed")
        #expect(attach.operation?.outcome == .notExecuted)
        #expect(backend.registry.activeSessionCount() == 0)

        platform.attachError = nil
        let owned = try backend.registry.register(
            application: platform.application, ownership: .owned,
            root: MacOSHostElement(raw: platform.root)
        )
        platform.identityStatusValue = .unconfirmed
        let terminate = try support.execute(dispatcher, support.call(
            id: "terminate-unconfirmed", method: "session.terminate", intent: .lifecycle,
            scope: .session(hostInstanceID: backend.descriptor.hostInstanceID,
                            sessionID: owned.sessionID),
            operationID: "operation-terminate-unconfirmed"
        ))
        #expect(terminate.error?.code == "termination_unconfirmed")
        #expect(terminate.operation?.outcome == .unknown)
        #expect(backend.registry.activeSessionCount() == 1)
    }

    @Test("Action loses identity before submission and is never performed")
    func actionIdentityLost() throws {
        let platform = FakeMacOSHostPlatform()
        platform.findMap["field"] = [platform.field]
        let backend = MacOSNativeBackend(hostInstanceID: "action-identity", platform: platform)
        let dispatcher = NativeHostDispatcher(backend: backend)
        let session = try attach(dispatcher, backend)
        let found = try support.execute(dispatcher, support.call(
            id: "find-field", method: "element.find", intent: .observe,
            scope: .session(hostInstanceID: backend.descriptor.hostInstanceID,
                            sessionID: session.sessionID),
            payload: findPayload()
        ))
        guard case let .object(result)? = found.result,
              case let .object(handle)? = result["handle"],
              case let .string(handleID)? = handle["handleId"] else {
            Issue.record("missing field handle")
            return
        }
        platform.onValidateAction = { platform.identityStatusValue = .unconfirmed }
        let response = try support.execute(dispatcher, support.call(
            id: "press-lost", method: "element.action", intent: .mutate,
            scope: .handle(hostInstanceID: backend.descriptor.hostInstanceID,
                           sessionID: session.sessionID, handleID: handleID),
            payload: actionPayload(rootID: session.rootID, processID: platform.application.processID),
            operationID: "operation-press-lost"
        ))
        #expect(response.error?.code == "application_identity_unconfirmed")
        #expect(response.operation?.outcome == .notExecuted)
        #expect(platform.performed.isEmpty)
    }

    @Test("Late cleanup evidence has an explicit bounded overflow marker")
    func evidenceCap() throws {
        let registry = MacOSOwnershipRegistry()
        let application = FakeMacOSHostPlatform().application
        for _ in 0...10_000 {
            let ticket = try registry.makeLateLaunch { _ in true }
            ticket.abandon()
            ticket.receive(.success(application))
        }
        let evidence = registry.evidenceSnapshot()
        #expect(evidence.count == 10_000)
        #expect(evidence.last?.reason == "cleanup_evidence_overflow")
        #expect(evidence.last?.incomplete == true)
    }

    private func attach(
        _ dispatcher: NativeHostDispatcher,
        _ backend: MacOSNativeBackend
    ) throws -> (sessionID: String, rootID: String) {
        let response = try support.execute(dispatcher, support.call(
            id: "attach", method: "session.attach", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: ["processId": .number(4_242)], operationID: "operation-attach"
        ))
        guard case let .object(value)? = response.result,
              case let .string(sessionID)? = value["sessionId"],
              case let .object(root)? = value["root"],
              case let .string(rootID)? = root["handleId"] else { throw MacOSPayload.invalid() }
        return (sessionID, rootID)
    }

    private func launchPayload() -> NativeJSONObject {
        ["executable": .object(["path": .string("/Applications/Fixture.app"), "arguments": .array([])])]
    }
    private func findPayload() -> NativeJSONObject {
        ["locator": .object(["backend": .string("ax"), "identifier": .string("field")]),
         "wait": .object(["timeoutMs": .number(0), "pollIntervalMs": .number(1)])]
    }
    private func actionPayload(rootID: String, processID: Int32) -> NativeJSONObject {
        ["action": .string("press"), "expectedTarget": .object([
            "locator": .object(["backend": .string("ax"), "identifier": .string("field")]),
            "processId": .number(Double(processID)), "rootElementId": .string(rootID),
        ])]
    }
}
