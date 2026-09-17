import Foundation
import Testing
import SurfaceLoomNativeProtocol
@testable import SurfaceLoomMacOSHost

@Suite("macOS backend lifecycle boundaries")
struct MacOSNativeBackendLifecycleTests {
    let support = NativeHostContractTests()

    @Test("Handshake method payload is strict and version-aware")
    func strictHandshakePayload() throws {
        let backend = MacOSNativeBackend(hostInstanceID: "macos-handshake", platform: FakeMacOSHostPlatform())
        let dispatcher = NativeHostDispatcher(backend: backend)
        let rejected = try support.execute(dispatcher, support.call(
            id: "bad-handshake", method: "host.handshake", intent: .observe,
            scope: .bootstrap,
            payload: ["supportedVersions": .array([.string("2.0")])]
        ))
        #expect(rejected.error?.code == "protocol_version_mismatch")
        let accepted = try support.execute(dispatcher, support.call(
            id: "good-handshake", method: "host.handshake", intent: .observe,
            scope: .bootstrap,
            payload: ["client": .string("contract"),
                      "supportedVersions": .array([.string("1.0")])]
        ))
        #expect(accepted.isSuccess)
    }

    @Test("EOF cleanup terminates owned sessions but only releases borrowed sessions")
    func backendShutdownHonorsOwnership() throws {
        let platform = FakeMacOSHostPlatform()
        let registry = MacOSOwnershipRegistry()
        let backend = MacOSNativeBackend(hostInstanceID: "macos-shutdown", platform: platform, registry: registry)
        let dispatcher = NativeHostDispatcher(backend: backend)
        platform.onBeginLaunch = { platform.completeLaunch() }
        let launched = try support.execute(dispatcher, support.call(
            id: "launch", method: "session.launch", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: ["executable": .object([
                "path": .string("/Applications/Fixture.app"), "arguments": .array([]),
            ])], operationID: "operation-launch"
        ))
        #expect(launched.isSuccess)
        let borrowedApplication = MacOSApplicationIdentity(
            processID: 4_243, startSeconds: 101, startMicroseconds: 3,
            bundleIdentifier: "test.borrowed"
        )
        _ = try registry.register(
            application: borrowedApplication, ownership: .borrowed,
            root: MacOSHostElement(raw: FakeMacOSHostPlatform.Element("borrowed-root"))
        )
        #expect(registry.activeSessionCount() == 2)
        _ = backend.shutdown()
        #expect(platform.terminateCalls == 1)
        #expect(registry.activeSessionCount() == 0)
        #expect(registry.evidenceSnapshot().last?.stopped == true)
    }

    @Test("Cancelled submitted launch keeps its late receiver until cleanup")
    func cancelledLaunchRetainsReceiver() throws {
        let platform = FakeMacOSHostPlatform()
        let backend = MacOSNativeBackend(hostInstanceID: "macos-cancel-launch", platform: platform)
        let dispatcher = NativeHostDispatcher(backend: backend)
        let prepared = try dispatcher.prepare(support.call(
            id: "launch-cancel", method: "session.launch", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: launchPayload(), operationID: "operation-cancel", timeout: 1_000
        ), receivedUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds)
        let entered = DispatchSemaphore(value: 0)
        let completed = DispatchSemaphore(value: 0)
        let output = NativeHostContractTests.LockedData()
        platform.onBeginLaunch = { entered.signal() }
        DispatchQueue.global().async {
            output.set(dispatcher.makeOutboundFrame(for: prepared))
            dispatcher.complete(prepared)
            completed.signal()
        }
        #expect(entered.wait(timeout: .now() + 2) == .success)
        dispatcher.cancel(NativeCancel(id: "cancel", requestID: "launch-cancel", reason: .caller))
        #expect(completed.wait(timeout: .now() + 2) == .success)
        let response = try support.responseLines(output.value).first!
        #expect(response.error?.code == "request_cancelled")
        #expect(response.operation?.outcome == .unknown)
        #expect(backend.registry.pendingLaunchCount() == 1)
        platform.completeLaunch()
        #expect(backend.registry.pendingLaunchCount() == 0)
        #expect(platform.terminateCalls == 1)
    }

    @Test("Unconfirmed late cleanup remains owned for a later shutdown retry")
    func unconfirmedLateCleanupIsRetained() throws {
        let platform = FakeMacOSHostPlatform()
        platform.terminateSucceeds = false
        let backend = MacOSNativeBackend(hostInstanceID: "macos-unresolved", platform: platform)
        let dispatcher = NativeHostDispatcher(backend: backend)
        let response = try support.execute(dispatcher, support.call(
            id: "launch-timeout", method: "session.launch", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: launchPayload(), operationID: "operation-timeout", timeout: 5
        ))
        #expect(response.operation?.outcome == .unknown)
        platform.completeLaunch()
        #expect(backend.registry.pendingLaunchCount() == 0)
        #expect(backend.registry.unresolvedSnapshot().count == 1)
        #expect(backend.registry.evidenceSnapshot().last?.stopped == false)
    }

    @Test("Live doctor reads the current host identity without requesting TCC")
    func liveDoctorIdentity() throws {
        let backend = MacOSNativeBackend(hostInstanceID: "macos-live-doctor", platform: MacOSLivePlatform())
        let response = try support.execute(NativeHostDispatcher(backend: backend), support.call(
            id: "doctor-live", method: "host.doctor", intent: .observe,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID)
        ))
        guard case let .object(result)? = response.result,
              case let .object(host)? = result["host"],
              case let .object(accessibility)? = result["accessibility"] else {
            Issue.record("Missing live doctor identity")
            return
        }
        #expect(host["processId"] == .number(Double(ProcessInfo.processInfo.processIdentifier)))
        #expect(host["executableName"] != nil)
        #expect(!host.keys.contains("path"))
        #expect(accessibility["promptRequested"] == .bool(false))
        #expect(accessibility["automaticAuthorization"] == .bool(false))
    }

    private func launchPayload() -> NativeJSONObject {
        ["executable": .object([
            "path": .string("/Applications/Fixture.app"), "arguments": .array([]),
        ])]
    }
}
