import Foundation
import Testing
import SurfaceLoomNativeProtocol
@testable import SurfaceLoomMacOSHost

@Suite("macOS host output ownership")
struct NativeHostBackpressureTests {
    @Test("Outstanding id remains owned through a blocked terminal write")
    func blockedWriterPreservesAtMostOnce() throws {
        let support = NativeHostContractTests()
        let hostID = "macos-backpressure"
        let entered = DispatchSemaphore(value: 0)
        let calls = NativeHostContractTests.LockedCounter()
        let dispatcher = NativeHostDispatcher(descriptor: support.descriptor(hostID: hostID)) { _, _ in
            calls.increment()
            entered.signal()
            return .object(["padding": .string(String(repeating: "x", count: 200_000))])
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

        pipes.write(support.request(id: "blocked", method: "test.mutate", intent: "mutate", hostID: hostID,
                                    operationID: "operation-first") + "\n")
        #expect(entered.wait(timeout: .now() + 2) == .success)
        Thread.sleep(forTimeInterval: 0.03)
        pipes.write(support.request(id: "blocked", method: "test.mutate", intent: "mutate", hostID: hostID,
                                    operationID: "operation-second") + "\n")
        pipes.closeInput()
        Thread.sleep(forTimeInterval: 0.03)
        #expect(calls.value == 1)
        #expect(completed.wait(timeout: .now()) == .timedOut)

        let captured = NativeHostContractTests.LockedData()
        let drained = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            captured.set(pipes.output.fileHandleForReading.readDataToEndOfFile())
            drained.signal()
        }
        #expect(completed.wait(timeout: .now() + 3) == .success)
        pipes.output.fileHandleForWriting.closeFile()
        pipes.diagnostics.fileHandleForWriting.closeFile()
        #expect(drained.wait(timeout: .now() + 2) == .success)
        let responses = try support.responseLines(captured.value)
        #expect(responses.count == 1)
        #expect(responses.first?.id == "blocked")
        #expect(calls.value == 1)
        let diagnostics = String(decoding: pipes.diagnostics.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        #expect(diagnostics.contains("one terminal response"))
    }

    @Test("Output failure terminates later queued execution")
    func outputFailureStopsConnection() throws {
        let support = NativeHostContractTests()
        let hostID = "macos-output-failure"
        let calls = NativeHostContractTests.LockedCounter()
        let dispatcher = NativeHostDispatcher(descriptor: support.descriptor(hostID: hostID)) { _, _ in
            calls.increment()
            return .object(["done": .bool(true)])
        }
        let input = Pipe()
        let diagnostics = Pipe()
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        FileManager.default.createFile(atPath: path.path, contents: Data())
        let closedOutput = try FileHandle(forWritingTo: path)
        try closedOutput.close()
        defer { try? FileManager.default.removeItem(at: path) }

        let frames = support.request(id: "first", method: "test.mutate", intent: "mutate", hostID: hostID,
                                     operationID: "operation-first") + "\n" +
            support.request(id: "second", method: "test.mutate", intent: "mutate", hostID: hostID,
                            operationID: "operation-second") + "\n"
        input.fileHandleForWriting.write(Data(frames.utf8))
        let status = NativeHostContractTests.LockedInt()
        let completed = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            status.set(Int(NativeStdioHost(dispatcher: dispatcher).run(
                input: input.fileHandleForReading,
                output: closedOutput,
                diagnostics: diagnostics.fileHandleForWriting
            )))
            completed.signal()
        }
        #expect(completed.wait(timeout: .now() + 2) == .success)
        input.fileHandleForWriting.closeFile()
        diagnostics.fileHandleForWriting.closeFile()
        #expect(status.value == 1)
        #expect(calls.value == 1)
        let text = String(decoding: diagnostics.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        #expect(text == "Native output stopped after a write failure.\n")
    }
}
