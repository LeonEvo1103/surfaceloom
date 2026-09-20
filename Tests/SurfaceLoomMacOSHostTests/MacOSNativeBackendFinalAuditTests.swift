import ApplicationServices
import Darwin
import Foundation
import Testing
import SurfaceLoomNativeProtocol
@testable import SurfaceLoomMacOSHost

@Suite("macOS native final lifecycle audit")
struct MacOSNativeBackendFinalAuditTests {
    let support = NativeHostContractTests()

    @Test("EOF keeps the host alive until a pending launch receiver is terminal")
    func eofWaitsForLaunchReceiver() throws {
        let platform = FakeMacOSHostPlatform()
        let backend = MacOSNativeBackend(hostInstanceID: "eof-pending", platform: platform)
        let dispatcher = NativeHostDispatcher(backend: backend)
        let pipes = NativeHostContractTests.HostPipes()
        let finished = DispatchSemaphore(value: 0)
        let status = NativeHostContractTests.LockedInt()
        let request = support.call(
            id: "pending-launch", method: "session.launch", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: launchPayload(), operationID: "operation-pending", timeout: 5
        )
        DispatchQueue.global().async {
            status.set(Int(NativeStdioHost(dispatcher: dispatcher).run(
                input: pipes.input.fileHandleForReading,
                output: pipes.output.fileHandleForWriting,
                diagnostics: pipes.diagnostics.fileHandleForWriting
            )))
            finished.signal()
        }
        pipes.input.fileHandleForWriting.write(try NativeWireCodec.encode(.request(request)))
        pipes.closeInput()
        let pendingDeadline = Date().addingTimeInterval(2)
        while backend.registry.pendingLaunchCount() == 0, Date() < pendingDeadline {
            Thread.sleep(forTimeInterval: 0.001)
        }
        Thread.sleep(forTimeInterval: 0.05)
        #expect(finished.wait(timeout: .now()) == .timedOut)
        #expect(backend.registry.pendingLaunchCount() == 1)
        #expect(backend.registry.unconfirmedResponsibilityCount() == 1)
        #expect(platform.terminateCalls == 0)

        platform.completeLaunch()
        #expect(finished.wait(timeout: .now() + 2) == .success)
        #expect(status.value == 0)
        #expect(platform.terminateCalls == 1)
        #expect(backend.registry.unconfirmedResponsibilityCount() == 0)
        closeHostOutputs(pipes)
    }

    @Test("Main-thread host run drains late cleanup before returning")
    func mainThreadRunWaitsForLateCleanup() throws {
        let platform = FakeMacOSHostPlatform()
        let backend = MacOSNativeBackend(hostInstanceID: "late-cleanup-drain", platform: platform)
        let dispatcher = NativeHostDispatcher(backend: backend)
        let pipes = NativeHostContractTests.HostPipes()
        let cleanupEntered = DispatchSemaphore(value: 0)
        let cleanupRelease = DispatchSemaphore(value: 0)
        let launchEntered = DispatchSemaphore(value: 0)
        let callbackDone = DispatchSemaphore(value: 0)
        let runDone = DispatchSemaphore(value: 0)
        let runReturned = LockedBool()
        let observedBlocked = LockedBool()
        let status = NativeHostContractTests.LockedInt()
        platform.onTerminate = {
            cleanupEntered.signal()
            cleanupRelease.wait()
        }
        platform.onBeginLaunch = { launchEntered.signal() }
        let request = support.call(
            id: "late-cleanup", method: "session.launch", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: launchPayload(), operationID: "operation-late-cleanup", timeout: 5
        )
        pipes.input.fileHandleForWriting.write(try NativeWireCodec.encode(.request(request)))
        pipes.closeInput()
        DispatchQueue.global().async {
            guard launchEntered.wait(timeout: .now() + 10) == .success else {
                callbackDone.signal()
                return
            }
            let deadline = Date().addingTimeInterval(10)
            while dispatcher.isOutstanding("late-cleanup"), Date() < deadline {
                Thread.sleep(forTimeInterval: 0.001)
            }
            platform.completeLaunch()
            callbackDone.signal()
        }

        if Thread.isMainThread {
            let observationDone = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                _ = cleanupEntered.wait(timeout: .now() + 10)
                Thread.sleep(forTimeInterval: 0.05)
                observedBlocked.set(!runReturned.value)
                cleanupRelease.signal()
                observationDone.signal()
            }
            status.set(Int(NativeStdioHost(dispatcher: dispatcher).run(
                input: pipes.input.fileHandleForReading,
                output: pipes.output.fileHandleForWriting,
                diagnostics: pipes.diagnostics.fileHandleForWriting
            )))
            runReturned.set(true)
            #expect(observationDone.wait(timeout: .now() + 10) == .success)
        } else {
            DispatchQueue.main.async {
                status.set(Int(NativeStdioHost(dispatcher: dispatcher).run(
                    input: pipes.input.fileHandleForReading,
                    output: pipes.output.fileHandleForWriting,
                    diagnostics: pipes.diagnostics.fileHandleForWriting
                )))
                runReturned.set(true)
                runDone.signal()
            }
            #expect(cleanupEntered.wait(timeout: .now() + 10) == .success)
            Thread.sleep(forTimeInterval: 0.05)
            observedBlocked.set(!runReturned.value)
            #expect(backend.registry.pendingLaunchCount() == 1)
            cleanupRelease.signal()
            #expect(runDone.wait(timeout: .now() + 10) == .success)
        }
        #expect(observedBlocked.value)
        #expect(callbackDone.wait(timeout: .now() + 10) == .success)
        #expect(status.value == 0)
        #expect(backend.registry.pendingLaunchCount() == 0)
        #expect(backend.registry.evidenceSnapshot().last?.stopped == true)
        closeHostOutputs(pipes)
    }

    @Test("Concurrent shutdown shares one late-cleanup flight and a later shutdown retries")
    func cleanupResponsibilityIsSingleFlight() throws {
        let platform = FakeMacOSHostPlatform()
        let registry = MacOSOwnershipRegistry()
        let backend = MacOSNativeBackend(
            hostInstanceID: "cleanup-single-flight", platform: platform, registry: registry
        )
        let cleanupEntries = NativeHostContractTests.LockedCounter()
        let cleanupEntered = DispatchSemaphore(value: 0)
        let cleanupRelease = DispatchSemaphore(value: 0)
        let callbackDone = DispatchSemaphore(value: 0)
        let shutdownStarted = DispatchSemaphore(value: 0)
        let shutdownDone = DispatchSemaphore(value: 0)
        let shutdownResult = NativeHostContractTests.LockedInt()
        platform.terminateSucceeds = false
        platform.onTerminate = {
            cleanupEntries.increment()
            cleanupEntered.signal()
            cleanupRelease.wait()
        }
        let ticket = try registry.makeLateLaunch { application in
            platform.terminate(application, force: true, timeoutMilliseconds: 5_000)
        }
        ticket.abandon()
        DispatchQueue.global().async {
            ticket.receive(.success(platform.application))
            callbackDone.signal()
        }
        #expect(cleanupEntered.wait(timeout: .now() + 2) == .success)
        DispatchQueue.global().async {
            shutdownStarted.signal()
            shutdownResult.set(backend.shutdown() ? 1 : 0)
            shutdownDone.signal()
        }
        #expect(shutdownStarted.wait(timeout: .now() + 2) == .success)
        Thread.sleep(forTimeInterval: 0.05)
        #expect(cleanupEntries.value == 1)
        #expect(shutdownDone.wait(timeout: .now()) == .timedOut)

        // A second signal keeps the regression failure itself from stranding a worker.
        cleanupRelease.signal()
        cleanupRelease.signal()
        #expect(callbackDone.wait(timeout: .now() + 2) == .success)
        #expect(shutdownDone.wait(timeout: .now() + 2) == .success)
        #expect(shutdownResult.value == 0)
        #expect(platform.terminateCalls == 1)
        let firstEvidence = registry.evidenceSnapshot().filter { $0.launchID == ticket.launchID }
        #expect(firstEvidence.count == 1)
        #expect(firstEvidence.first?.reason == "cleanup_unconfirmed")
        #expect(!registry.evidenceSnapshot().contains {
            $0.reason == "identity_protected_by_existing_responsibility"
        })

        platform.onTerminate = nil
        platform.terminateSucceeds = true
        #expect(backend.shutdown())
        #expect(platform.terminateCalls == 2)
        #expect(registry.evidenceSnapshot().filter { $0.launchID == ticket.launchID }.count == 2)
        #expect(registry.unresolvedSnapshot().isEmpty)
    }

    @Test("Shutdown retries the same acquired responsibility after cleanup recovers")
    func stableCleanupResponsibility() throws {
        let platform = FakeMacOSHostPlatform()
        let backend = MacOSNativeBackend(hostInstanceID: "stable-cleanup", platform: platform)
        let cancellation = NativeCancellationState()
        let context = NativeHostExecutionContext(
            cancellation: cancellation,
            deadline: NativeHostDeadline(
                receivedUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds,
                timeoutMilliseconds: 5_000
            )
        )
        platform.onBeginLaunch = { platform.completeLaunch() }
        let command = try backend.prepare(request: support.call(
            id: "launch-cleanup", method: "session.launch", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: launchPayload(), operationID: "operation-cleanup"
        ), context: context)
        _ = try command.execute()
        platform.terminateSucceeds = false
        #expect(command.responseExpired() == .unknown)
        let session = try #require(backend.registry.sessionsSnapshot().first)
        let responsibilityID = try #require(session.responsibilityID)
        #expect(backend.registry.unresolvedSnapshot().first?.0 == responsibilityID)
        #expect(backend.registry.activeSessionCount() == 1)
        #expect(platform.terminateCalls == 1)

        platform.terminateSucceeds = true
        #expect(backend.shutdown())
        #expect(platform.terminateCalls == 2)
        #expect(backend.registry.activeSessionCount() == 0)
        #expect(backend.registry.unresolvedSnapshot().isEmpty)
        #expect(backend.registry.unconfirmedResponsibilityCount() == 0)
    }

    @Test("Cancellation during a blocked real stdout write cleans the acquisition")
    func cancelDuringBlockedTerminalWrite() throws {
        let platform = FakeMacOSHostPlatform()
        let backend = MacOSNativeBackend(hostInstanceID: "write-cancel", platform: platform)
        let dispatcher = NativeHostDispatcher(backend: backend)
        let pipes = NativeHostContractTests.HostPipes()
        let prefixCount = try fillPipe(pipes.output.fileHandleForWriting)
        #expect(prefixCount > 0)
        let finished = DispatchSemaphore(value: 0)
        let status = NativeHostContractTests.LockedInt()
        platform.onBeginLaunch = { platform.completeLaunch() }
        DispatchQueue.global().async {
            status.set(Int(NativeStdioHost(dispatcher: dispatcher).run(
                input: pipes.input.fileHandleForReading,
                output: pipes.output.fileHandleForWriting,
                diagnostics: pipes.diagnostics.fileHandleForWriting
            )))
            finished.signal()
        }
        let request = support.call(
            id: "blocked-launch", method: "session.launch", intent: .lifecycle,
            scope: .host(hostInstanceID: backend.descriptor.hostInstanceID),
            payload: launchPayload(), operationID: "operation-blocked", timeout: 5_000
        )
        pipes.input.fileHandleForWriting.write(try NativeWireCodec.encode(.request(request)))
        let sessionDeadline = Date().addingTimeInterval(2)
        while backend.registry.activeSessionCount() == 0, Date() < sessionDeadline {
            Thread.sleep(forTimeInterval: 0.001)
        }
        #expect(backend.registry.activeSessionCount() == 1)
        Thread.sleep(forTimeInterval: 0.05)
        #expect(backend.registry.activeSessionCount() == 1)
        pipes.input.fileHandleForWriting.write(try NativeWireCodec.encode(.cancel(
            NativeCancel(id: "cancel-write", requestID: "blocked-launch", reason: .caller)
        )))
        pipes.closeInput()
        let cancelDeadline = Date().addingTimeInterval(2)
        while !dispatcher.isCancellationRequested("blocked-launch"), Date() < cancelDeadline {
            Thread.sleep(forTimeInterval: 0.001)
        }
        #expect(dispatcher.isCancellationRequested("blocked-launch"))
        #expect(backend.registry.activeSessionCount() == 1)
        #expect(platform.terminateCalls == 0)
        #expect(finished.wait(timeout: .now()) == .timedOut)
        let prefix = try pipes.output.fileHandleForReading.read(upToCount: prefixCount) ?? Data()
        #expect(prefix.count == prefixCount)
        #expect(finished.wait(timeout: .now() + 3) == .success)
        #expect(status.value == 0)
        #expect(platform.terminateCalls == 1)
        #expect(backend.registry.activeSessionCount() == 0)
        closeHostOutputs(pipes)
    }

    @Test("Injected AX timeout uses the positive remaining request budget")
    func messagingTimeoutUsesRemainingBudget() throws {
        let recorder = TimeoutRecorder()
        let timeout = MacOSAXMessagingTimeout { _, seconds in
            recorder.record(seconds)
            return .success
        }
        let context = NativeHostExecutionContext(
            cancellation: NativeCancellationState(),
            deadline: NativeHostDeadline(
                receivedUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds,
                timeoutMilliseconds: 250
            )
        )
        let element = AXUIElementCreateSystemWide()
        try timeout.configure(element, context: context)
        let applied = try #require(recorder.values.first)
        #expect(applied > 0)
        #expect(applied <= 0.25)
        let platform = MacOSLivePlatform(messagingTimeout: timeout)
        _ = try? platform.children(element, context: context)
        _ = try? platform.optionalAttribute(kAXRoleAttribute, element, context: context)
        _ = try? platform.copyActionNames(element, context: context)
        _ = try? platform.settable(kAXFocusedAttribute, element, context: context)
        let handle = MacOSHostElement(nativeAX: element)
        _ = try? platform.validateAction(.press, on: handle, context: context)
        _ = try? platform.perform(.press, value: nil, on: handle, context: context)
        #expect(recorder.values.count >= 7)
    }

    private func launchPayload() -> NativeJSONObject {
        ["executable": .object([
            "path": .string("/Applications/Fixture.app"), "arguments": .array([]),
        ])]
    }

    private func fillPipe(_ handle: FileHandle) throws -> Int {
        let descriptor = handle.fileDescriptor
        let original = fcntl(descriptor, F_GETFL)
        guard original >= 0, fcntl(descriptor, F_SETFL, original | O_NONBLOCK) == 0 else {
            throw CocoaError(.fileWriteUnknown)
        }
        defer { _ = fcntl(descriptor, F_SETFL, original) }
        let bytes = [UInt8](repeating: 0x58, count: 4_096)
        var total = 0
        while true {
            let written = bytes.withUnsafeBytes {
                Darwin.write(descriptor, $0.baseAddress, $0.count)
            }
            if written > 0 { total += written; continue }
            if written < 0, errno == EAGAIN { break }
            throw CocoaError(.fileWriteUnknown)
        }
        return total
    }

    private func closeHostOutputs(_ pipes: NativeHostContractTests.HostPipes) {
        pipes.output.fileHandleForWriting.closeFile()
        pipes.diagnostics.fileHandleForWriting.closeFile()
        _ = pipes.output.fileHandleForReading.readDataToEndOfFile()
        _ = pipes.diagnostics.fileHandleForReading.readDataToEndOfFile()
    }
}

private final class TimeoutRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Float] = []
    func record(_ value: Float) { lock.withLock { storage.append(value) } }
    var values: [Float] { lock.withLock { storage } }
}

private final class LockedBool: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = false
    func set(_ value: Bool) { lock.withLock { storage = value } }
    var value: Bool { lock.withLock { storage } }
}
