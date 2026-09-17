import Foundation
import Testing
import SurfaceLoomNativeProtocol
@testable import SurfaceLoomMacOSHost

extension NativeHostContractTests {
    final class LockedCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var storage = 0

        func increment() {
            lock.lock(); storage += 1; lock.unlock()
        }

        var value: Int {
            lock.lock(); defer { lock.unlock() }
            return storage
        }
    }

    final class LockedData: @unchecked Sendable {
        private let lock = NSLock()
        private var storage = Data()

        func set(_ data: Data) { lock.lock(); storage = data; lock.unlock() }
        var value: Data { lock.lock(); defer { lock.unlock() }; return storage }
    }

    final class LockedInt: @unchecked Sendable {
        private let lock = NSLock()
        private var storage = 0
        func set(_ value: Int) { lock.lock(); storage = value; lock.unlock() }
        var value: Int { lock.lock(); defer { lock.unlock() }; return storage }
    }

    struct HostPipes: @unchecked Sendable {
        let input = Pipe()
        let output = Pipe()
        let diagnostics = Pipe()

        func write(_ text: String) {
            input.fileHandleForWriting.write(Data(text.utf8))
        }

        func closeInput() { input.fileHandleForWriting.closeFile() }

        func finish() -> (output: Data, diagnostics: String) {
            output.fileHandleForWriting.closeFile()
            diagnostics.fileHandleForWriting.closeFile()
            return (
                output.fileHandleForReading.readDataToEndOfFile(),
                String(decoding: diagnostics.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            )
        }
    }

    func run(_ data: Data, dispatcher: NativeHostDispatcher = NativeHostDispatcher()) -> (output: Data, diagnostics: String) {
        let pipes = HostPipes()
        pipes.input.fileHandleForWriting.write(data)
        pipes.closeInput()
        _ = NativeStdioHost(dispatcher: dispatcher).run(
            input: pipes.input.fileHandleForReading,
            output: pipes.output.fileHandleForWriting,
            diagnostics: pipes.diagnostics.fileHandleForWriting
        )
        return pipes.finish()
    }

    func responseLines(_ data: Data) throws -> [NativeResponse] {
        let reader = NativeFrameReader()
        var responses: [NativeResponse] = []
        for byte in data {
            guard let frame = try reader.append(byte) else { continue }
            guard case let .response(response) = try NativeWireCodec.decode(frame) else {
                throw NativeProtocolError(code: "invalid_message", message: "Expected response.")
            }
            responses.append(response)
        }
        #expect(try reader.finish() == nil)
        return responses
    }

    func handshake(id: String) -> String {
        "{\"protocol\":\"surfaceloom.native\",\"version\":\"1.0\",\"type\":\"request\"," +
        "\"id\":\"\(id)\",\"deadline\":{\"timeoutMs\":1000},\"call\":{" +
        "\"name\":\"host.handshake\",\"intent\":\"observe\",\"scope\":{\"kind\":\"bootstrap\"},\"payload\":{}}}"
    }

    func request(
        id: String,
        method: String,
        intent: String,
        hostID: String,
        operationID: String? = nil,
        timeout: Int = 10_000
    ) -> String {
        let operation = operationID.map { ",\"operationId\":\"\($0)\"" } ?? ""
        return "{\"protocol\":\"surfaceloom.native\",\"version\":\"1.0\",\"type\":\"request\"," +
            "\"id\":\"\(id)\",\"deadline\":{\"timeoutMs\":\(timeout)},\"call\":{" +
            "\"name\":\"\(method)\",\"intent\":\"\(intent)\",\"scope\":{\"kind\":\"host\"," +
            "\"hostInstanceId\":\"\(hostID)\"},\"payload\":{}\(operation)}}"
    }

    func cancel(id: String, requestID: String) -> String {
        "{\"protocol\":\"surfaceloom.native\",\"version\":\"1.0\",\"type\":\"cancel\"," +
        "\"id\":\"\(id)\",\"requestId\":\"\(requestID)\",\"reason\":\"caller\"}"
    }
}
