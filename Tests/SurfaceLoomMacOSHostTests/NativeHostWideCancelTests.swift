import Foundation
import Testing
import SurfaceLoomNativeProtocol
@testable import SurfaceLoomMacOSHost

@Suite("macOS host wide-request intake")
struct NativeHostWideCancelTests {
    @Test("Wide request construction does not starve the independent cancel reader")
    func wideRequestThenCancel() throws {
        let support = NativeHostContractTests()
        let hostID = "macos-wide-cancel"
        let blockerEntered = DispatchSemaphore(value: 0)
        let releaseBlocker = DispatchSemaphore(value: 0)
        let mutationCalls = NativeHostContractTests.LockedCounter()
        let dispatcher = NativeHostDispatcher(descriptor: support.descriptor(hostID: hostID)) { request, _ in
            if request.call.name == "test.block" {
                blockerEntered.signal()
                releaseBlocker.wait()
                return .object(["done": .bool(true)])
            }
            mutationCalls.increment()
            return .object(["unexpected": .bool(true)])
        }
        let pipes = NativeHostContractTests.HostPipes()
        let completed = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            _ = NativeStdioHost(dispatcher: dispatcher).run(
                input: pipes.input.fileHandleForReading,
                output: pipes.output.fileHandleForWriting,
                diagnostics: pipes.diagnostics.fileHandleForWriting
            )
            completed.signal()
        }

        pipes.write(support.request(id: "block-wide", method: "test.block", intent: "observe", hostID: hostID) + "\n")
        #expect(blockerEntered.wait(timeout: .now() + 2) == .success)

        let entries = (0..<8_192).map { ("payload-key-\($0)", NativeJSONValue.number(Double($0))) }
        let wide = NativeRequest(
            id: "wide",
            timeoutMilliseconds: 10_000,
            call: NativeCall(name: "test.mutate", intent: .mutate,
                             scope: .host(hostInstanceID: hostID),
                             payload: NativeJSONObject(entries), operationID: "operation-wide")
        )
        var inbound = try NativeWireCodec.encode(.request(wide))
        inbound.append(try NativeWireCodec.encode(.cancel(NativeCancel(
            id: "cancel-wide", requestID: "wide", reason: .caller
        ))))
        pipes.input.fileHandleForWriting.write(inbound)

        // This is a deadlock/complexity safety bound, not a microbenchmark:
        // indexed construction is far below it, while quadratic construction
        // fails to make the following cancel observable for this 8k payload.
        let safetyDeadline = Date().addingTimeInterval(8)
        while !dispatcher.isCancellationRequested("wide"), Date() < safetyDeadline {
            Thread.sleep(forTimeInterval: 0.002)
        }
        #expect(dispatcher.isCancellationRequested("wide"))
        pipes.closeInput()
        releaseBlocker.signal()
        #expect(completed.wait(timeout: .now() + 3) == .success)
        let responses = try support.responseLines(pipes.finish().output)
        #expect(responses.count == 2)
        #expect(responses.first { $0.id == "wide" }?.operation?.outcome == .notExecuted)
        #expect(mutationCalls.value == 0)
    }
}
