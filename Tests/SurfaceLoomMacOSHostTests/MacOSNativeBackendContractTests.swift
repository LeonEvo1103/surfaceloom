import Foundation
import Testing
import SurfaceLoomNativeProtocol
@testable import SurfaceLoomMacOSHost

@Suite("macOS AX backend contract")
struct MacOSNativeBackendContractTests {
    let support = NativeHostContractTests()

    @Test("Descriptor advertises only implemented AX methods")
    func advertisedMethodsAreExact() {
        let backend = MacOSNativeBackend(hostInstanceID: "macos-contract", platform: FakeMacOSHostPlatform())
        #expect(backend.descriptor.backend == "ax")
        #expect(backend.descriptor.methods == MacOSHostMethod.advertised)
        let names = Set(backend.descriptor.methods.map(\.name))
        #expect(!names.contains("session.desktop"))
        #expect(!names.contains("session.close"))
        #expect(!names.contains("element.findAll"))
        #expect(!names.contains("element.queryBatch"))
    }

    @Test("Doctor is prompt-free and exposes bounded host identity without a path")
    func doctorAndCapabilities() throws {
        let platform = FakeMacOSHostPlatform()
        platform.trusted = false
        let backend = MacOSNativeBackend(hostInstanceID: "macos-doctor", platform: platform)
        let dispatcher = NativeHostDispatcher(backend: backend)
        let doctor = try support.execute(dispatcher, support.call(
            id: "doctor", method: "host.doctor", intent: .observe,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID)
        ))
        guard case let .object(result)? = doctor.result,
              case let .object(accessibility)? = result["accessibility"],
              case let .object(host)? = result["host"] else {
            Issue.record("Missing doctor result")
            return
        }
        #expect(result["canStartSession"] == .bool(false))
        #expect(accessibility["trusted"] == .bool(false))
        #expect(accessibility["promptRequested"] == .bool(false))
        #expect(host["executableName"] == .string("fixture-host"))
        #expect(!host.keys.contains("path"))

        let capabilities = try support.execute(dispatcher, support.call(
            id: "capabilities", method: "capabilities.get", intent: .observe,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID)
        ))
        guard case let .object(value)? = capabilities.result else { return }
        #expect(value["protocolVersion"] == .string("1.0"))
        #expect(value["architecture"] == .string("arm64"))
        #expect(value["accessibilityTrusted"] == .bool(false))
    }

    @Test("TCC denial fails before launch submission")
    func tccDenialIsNotSubmitted() throws {
        let platform = FakeMacOSHostPlatform()
        platform.trusted = false
        let backend = MacOSNativeBackend(hostInstanceID: "macos-denied", platform: platform)
        let response = try support.execute(NativeHostDispatcher(backend: backend), support.call(
            id: "launch-denied", method: "session.launch", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: launchPayload(), operationID: "operation-denied"
        ))
        #expect(response.error?.code == "accessibility_permission_denied")
        #expect(response.operation?.outcome == .notExecuted)
        #expect(response.error?.retry == .safe)
        #expect(platform.launchBegins == 0)
        #expect(backend.registry.pendingLaunchCount() == 0)
    }

    @Test("Late launch after deadline is identified and cleanup is attempted")
    func lateLaunchCleanup() throws {
        let platform = FakeMacOSHostPlatform()
        let registry = MacOSOwnershipRegistry()
        let backend = MacOSNativeBackend(hostInstanceID: "macos-late", platform: platform, registry: registry)
        let dispatcher = NativeHostDispatcher(backend: backend)
        let prepared = try dispatcher.prepare(support.call(
            id: "launch-late", method: "session.launch", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: launchPayload(), operationID: "operation-late", timeout: 20
        ), receivedUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds)
        let output = NativeHostContractTests.LockedData()
        let completed = DispatchSemaphore(value: 0)
        let registrationObserved = NativeHostContractTests.LockedInt()
        platform.onBeginLaunch = { registrationObserved.set(registry.pendingLaunchCount()) }
        DispatchQueue.global().async {
            output.set(dispatcher.makeOutboundFrame(for: prepared))
            dispatcher.complete(prepared)
            completed.signal()
        }
        #expect(completed.wait(timeout: .now() + 2) == .success)
        let response = try support.responseLines(output.value).first!
        #expect(response.error?.code == "deadline_exceeded")
        #expect(response.operation?.outcome == .unknown)
        #expect(registrationObserved.value == 1)
        #expect(registry.pendingLaunchCount() == 1)

        platform.completeLaunch()
        #expect(registry.pendingLaunchCount() == 0)
        #expect(platform.terminateCalls == 1)
        #expect(registry.evidenceSnapshot().last?.attempted == true)
        #expect(registry.evidenceSnapshot().last?.stopped == true)
        #expect(registry.activeSessionCount() == 0)
    }

    @Test("Borrowed ownership, stale identity, and cross-session handles fail closed")
    func ownershipAndScope() throws {
        let platform = FakeMacOSHostPlatform()
        let backend = MacOSNativeBackend(hostInstanceID: "macos-scope", platform: platform)
        let dispatcher = NativeHostDispatcher(backend: backend)
        let first = try attach(dispatcher, backend, id: "attach-1", operation: "operation-1")
        let duplicateAttach = try support.execute(dispatcher, support.call(
            id: "attach-duplicate", method: "session.attach", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: ["processId": .number(Double(platform.application.processID))],
            operationID: "operation-duplicate"
        ))
        #expect(duplicateAttach.error?.code == "application_already_registered")
        #expect(duplicateAttach.operation?.outcome == .notExecuted)
        let secondRecord = try backend.registry.register(
            application: MacOSApplicationIdentity(processID: 9_999, startSeconds: 2,
                                                   startMicroseconds: 3, bundleIdentifier: "other.app"),
            ownership: .borrowed,
            root: MacOSHostElement(raw: FakeMacOSHostPlatform.Element("other-root"))
        )
        let second = (sessionID: secondRecord.sessionID, rootID: secondRecord.rootHandleID)

        let terminate = try support.execute(dispatcher, support.call(
            id: "terminate-borrowed", method: "session.terminate", intent: .lifecycle,
            scope: .session(hostInstanceID: backend.descriptor.hostInstanceID, sessionID: first.sessionID),
            operationID: "operation-terminate"
        ))
        #expect(terminate.error?.code == "ownership_required")
        #expect(terminate.operation?.outcome == .notExecuted)
        let cross = try support.execute(dispatcher, support.call(
            id: "cross-handle", method: "element.get", intent: .observe,
            scope: .handle(hostInstanceID: backend.descriptor.hostInstanceID,
                           sessionID: second.sessionID, handleID: first.rootID)
        ))
        #expect(cross.error?.code == "element_handle_unknown")
        let crossHost = try support.execute(dispatcher, support.call(
            id: "cross-host", method: "element.get", intent: .observe,
            scope: .handle(hostInstanceID: "macos-other-host",
                           sessionID: first.sessionID, handleID: first.rootID)
        ))
        #expect(crossHost.error?.code == "host_instance_stale")

        platform.current = false
        let stale = try support.execute(dispatcher, support.call(
            id: "stale", method: "element.get", intent: .observe,
            scope: .handle(hostInstanceID: backend.descriptor.hostInstanceID,
                           sessionID: first.sessionID, handleID: first.rootID)
        ))
        #expect(stale.error?.code == "session_stale")
    }

    @Test("Strict AX ambiguity fails and semantic action submits once")
    func strictResolutionAndAction() throws {
        let platform = FakeMacOSHostPlatform()
        platform.findMap["duplicate"] = [platform.field, platform.duplicate]
        platform.findMap["field"] = [platform.field]
        let backend = MacOSNativeBackend(hostInstanceID: "macos-action", platform: platform)
        let dispatcher = NativeHostDispatcher(backend: backend)
        let session = try attach(dispatcher, backend, id: "attach", operation: "operation-attach")
        let ambiguous = try support.execute(dispatcher, support.call(
            id: "ambiguous", method: "element.find", intent: .observe,
            scope: .session(hostInstanceID: backend.descriptor.hostInstanceID, sessionID: session.sessionID),
            payload: findPayload(identifier: "duplicate", timeout: 0)
        ))
        #expect(ambiguous.error?.code == "element_ambiguous")
        let found = try support.execute(dispatcher, support.call(
            id: "find", method: "element.find", intent: .observe,
            scope: .session(hostInstanceID: backend.descriptor.hostInstanceID, sessionID: session.sessionID),
            payload: findPayload(identifier: "field", timeout: 0)
        ))
        guard case let .object(result)? = found.result,
              case let .object(handle)? = result["handle"],
              case let .string(handleID)? = handle["handleId"] else {
            Issue.record("Missing element handle")
            return
        }
        let action = try support.execute(dispatcher, support.call(
            id: "press", method: "element.action", intent: .mutate,
            scope: .handle(hostInstanceID: backend.descriptor.hostInstanceID,
                           sessionID: session.sessionID, handleID: handleID),
            payload: actionPayload(rootID: session.rootID, processID: platform.application.processID),
            operationID: "operation-press"
        ))
        #expect(action.isSuccess)
        #expect(action.operation?.outcome == .executed)
        #expect(platform.performed == [.press])

        platform.failPerform = true
        let unconfirmed = try support.execute(dispatcher, support.call(
            id: "press-unconfirmed", method: "element.action", intent: .mutate,
            scope: .handle(hostInstanceID: backend.descriptor.hostInstanceID,
                           sessionID: session.sessionID, handleID: handleID),
            payload: actionPayload(rootID: session.rootID, processID: platform.application.processID),
            operationID: "operation-press-unconfirmed"
        ))
        #expect(unconfirmed.error?.code == "ax_action_unconfirmed")
        #expect(unconfirmed.operation?.outcome == .unknown)
        #expect(unconfirmed.error?.retry == .never)
        #expect(platform.performed == [.press])
    }

    private func attach(
        _ dispatcher: NativeHostDispatcher,
        _ backend: MacOSNativeBackend,
        id: String,
        operation: String
    ) throws -> (sessionID: String, rootID: String) {
        let response = try support.execute(dispatcher, support.call(
            id: id, method: "session.attach", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: ["processId": .number(4_242)], operationID: operation
        ))
        guard case let .object(value)? = response.result,
              case let .string(sessionID)? = value["sessionId"],
              case let .object(root)? = value["root"],
              case let .string(rootID)? = root["handleId"] else {
            throw MacOSPayload.invalid()
        }
        #expect(sessionID.hasPrefix("session-"))
        #expect(rootID.hasPrefix("handle-"))
        return (sessionID, rootID)
    }

    private func launchPayload() -> NativeJSONObject {
        ["executable": .object(["path": .string("/Applications/Fixture.app"), "arguments": .array([])])]
    }

    private func findPayload(identifier: String, timeout: Int) -> NativeJSONObject {
        ["locator": .object(["backend": .string("ax"), "identifier": .string(identifier)]),
         "wait": .object(["timeoutMs": .number(Double(timeout)), "pollIntervalMs": .number(1)])]
    }

    private func actionPayload(rootID: String, processID: Int32) -> NativeJSONObject {
        ["action": .string("press"), "expectedTarget": .object([
            "locator": .object(["backend": .string("ax"), "identifier": .string("field")]),
            "processId": .number(Double(processID)), "rootElementId": .string(rootID),
        ])]
    }
}
