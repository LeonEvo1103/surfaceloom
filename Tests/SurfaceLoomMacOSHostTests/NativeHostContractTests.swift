import Foundation
import Testing
import SurfaceLoomNativeProtocol
@testable import SurfaceLoomMacOSHost

@Suite("macOS stdio host contract")
struct NativeHostContractTests {
    @Test("Shell handshake does not advertise AX or lifecycle capability")
    func testShellHandshakeAdvertisesNoAXOrLifecycleCapability() throws {
        let descriptor = NativeHostDispatcher.shellDescriptor(hostInstanceID: "macos-test")
        #expect(descriptor.platform == "macos")
        #expect(descriptor.backend == "stdio-shell")
        #expect(descriptor.methods == [
            NativeMethodDescriptor(name: "host.handshake", intent: .observe, scopeKinds: ["bootstrap"]),
        ])

        let result = run(Data((handshake(id: "hello") + "\n").utf8))
        #expect(result.diagnostics == "")
        let response = try responseLines(result.output).first!
        #expect(response.isSuccess)
        guard case let .object(host)? = response.result,
              case let .array(methods)? = host["methods"] else {
            Issue.record("Missing descriptor")
            return
        }
        #expect(methods.count == 1)
    }

    @Test("Malformed input is redacted on stderr")
    func testMalformedInputClosesWithoutLeakingInputToStderr() {
        let secret = "/Users/example/private-token"
        let result = run(Data("{\"protocol\":\"surfaceloom.native\",\"secret\":\"\(secret)\"".utf8))
        #expect(result.output.isEmpty)
        #expect(!result.diagnostics.contains(secret))
        #expect(result.diagnostics.components(separatedBy: "\n").filter { !$0.isEmpty }.count == 1)
    }

    @Test("Reader accepts cancellation while serial executor is busy")
    func testReaderAcceptsCancelWhileSerialExecutorIsBusy() throws {
        let hostID = "macos-cancel-before"
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let mutationCalls = LockedCounter()
        let dispatcher = NativeHostDispatcher(descriptor: descriptor(hostID: hostID)) { request, _ in
            if request.call.name == "test.block" {
                entered.signal()
                release.wait()
                return .object(["done": .bool(true)])
            }
            mutationCalls.increment()
            return .object(["unexpected": .bool(true)])
        }
        let pipes = HostPipes()
        let completed = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            _ = NativeStdioHost(dispatcher: dispatcher).run(
                input: pipes.input.fileHandleForReading,
                output: pipes.output.fileHandleForWriting,
                diagnostics: pipes.diagnostics.fileHandleForWriting
            )
            completed.signal()
        }
        pipes.write(request(id: "block", method: "test.block", intent: "observe", hostID: hostID) + "\n")
        #expect(entered.wait(timeout: .now() + 2) == .success)
        pipes.write(request(id: "mutate", method: "test.mutate", intent: "mutate", hostID: hostID,
                            operationID: "operation-mutate") + "\n" + cancel(id: "cancel-mutate", requestID: "mutate") + "\n")
        pipes.closeInput()
        Thread.sleep(forTimeInterval: 0.05)
        release.signal()
        #expect(completed.wait(timeout: .now() + 2) == .success)
        let result = pipes.finish()
        let responses = try responseLines(result.output)
        #expect(responses.count == 2)
        let cancelled = responses.first { $0.id == "mutate" }
        #expect(cancelled?.operation?.outcome == .notExecuted)
        #expect(cancelled?.error?.retry == .safe)
        #expect(mutationCalls.value == 0)
    }

    @Test("Cancellation after submission without proof is unknown")
    func testCancelAfterSubmissionWithoutProofIsUnknown() throws {
        let hostID = "macos-cancel-after"
        let entered = DispatchSemaphore(value: 0)
        let dispatcher = NativeHostDispatcher(descriptor: descriptor(hostID: hostID)) { _, context in
            entered.signal()
            let limit = Date().addingTimeInterval(2)
            while !context.isCancellationRequested && Date() < limit { Thread.sleep(forTimeInterval: 0.002) }
            throw NativeHostBackendError(code: "backend_result_unavailable", category: .backend,
                                         safeMessage: "Completion is unknown.")
        }
        let pipes = HostPipes()
        let completed = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            _ = NativeStdioHost(dispatcher: dispatcher).run(
                input: pipes.input.fileHandleForReading, output: pipes.output.fileHandleForWriting,
                diagnostics: pipes.diagnostics.fileHandleForWriting
            )
            completed.signal()
        }
        pipes.write(request(id: "active", method: "test.mutate", intent: "mutate", hostID: hostID,
                            operationID: "operation-active") + "\n")
        #expect(entered.wait(timeout: .now() + 2) == .success)
        pipes.write(cancel(id: "cancel-active", requestID: "active") + "\n")
        pipes.closeInput()
        #expect(completed.wait(timeout: .now() + 3) == .success)
        let response = try responseLines(pipes.finish().output).first!
        #expect(response.operation?.outcome == .unknown)
        #expect(response.error?.retry == .never)
    }

    @Test("Deadline accounts for non-cooperative work without claiming forced stop")
    func deadlineDoesNotForceStopHandler() throws {
        let hostID = "macos-noncooperative"
        let dispatcher = NativeHostDispatcher(descriptor: descriptor(hostID: hostID)) { _, _ in
            Thread.sleep(forTimeInterval: 0.02)
            return .object(["late": .bool(true)])
        }
        let wire = request(id: "late", method: "test.mutate", intent: "mutate", hostID: hostID,
                           operationID: "operation-late", timeout: 5) + "\n"
        let result = run(Data(wire.utf8), dispatcher: dispatcher)
        let response = try responseLines(result.output).first!
        #expect(response.error?.code == "deadline_exceeded")
        #expect(response.operation?.outcome == .executed)
        #expect(response.error?.retry == .never)
    }

    @Test("Arrival deadline covers queue and duplicate gets no second terminal")
    func testArrivalDeadlineCoversQueueAndDuplicateGetsNoSecondTerminal() throws {
        let hostID = "macos-queue"
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let dispatcher = NativeHostDispatcher(descriptor: descriptor(hostID: hostID)) { request, _ in
            if request.call.name == "test.block" { entered.signal(); release.wait() }
            return .object(["done": .bool(true)])
        }
        let input = request(id: "same", method: "test.block", intent: "observe", hostID: hostID) + "\n" +
            request(id: "deadline", method: "test.mutate", intent: "mutate", hostID: hostID,
                    operationID: "operation-deadline", timeout: 5) + "\n" +
            "{\"protocol\":\"surfaceloom.native\",\"version\":\"1.0\",\"type\":\"request\"," +
            "\"id\":\"same\",\"unexpected\":true}\n"
        let pipes = HostPipes()
        let completed = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            _ = NativeStdioHost(dispatcher: dispatcher).run(
                input: pipes.input.fileHandleForReading, output: pipes.output.fileHandleForWriting,
                diagnostics: pipes.diagnostics.fileHandleForWriting
            )
            completed.signal()
        }
        pipes.write(input); pipes.closeInput()
        #expect(entered.wait(timeout: .now() + 2) == .success)
        Thread.sleep(forTimeInterval: 0.03); release.signal()
        #expect(completed.wait(timeout: .now() + 2) == .success)
        let result = pipes.finish()
        let responses = try responseLines(result.output)
        #expect(responses.filter { $0.id == "same" }.count == 1)
        #expect(responses.first { $0.id == "deadline" }?.operation?.outcome == .notExecuted)
        #expect(!result.diagnostics.isEmpty)
    }

    func descriptor(hostID: String) -> NativeHostDescriptor {
        NativeHostDescriptor(hostInstanceID: hostID, platform: "macos", backend: "test-shell", methods: [
            NativeMethodDescriptor(name: "host.handshake", intent: .observe, scopeKinds: ["bootstrap"]),
            NativeMethodDescriptor(name: "test.block", intent: .observe, scopeKinds: ["host"]),
            NativeMethodDescriptor(name: "test.mutate", intent: .mutate, scopeKinds: ["host"]),
        ])
    }
}
