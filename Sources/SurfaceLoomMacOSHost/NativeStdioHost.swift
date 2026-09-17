import Foundation
import SurfaceLoomNativeProtocol

public final class NativeStdioHost {
    private let dispatcher: NativeHostDispatcher
    private let executor = DispatchQueue(label: "surfaceloom.macos-host.executor")
    private let pending = DispatchGroup()

    public init(dispatcher: NativeHostDispatcher? = nil) {
        self.dispatcher = dispatcher ?? NativeHostDispatcher(backend: MacOSNativeBackend())
    }

    @discardableResult
    public func run(
        input: FileHandle = .standardInput,
        output: FileHandle = .standardOutput,
        diagnostics: FileHandle = .standardError
    ) -> Int32 {
        NativeBrokenPipeProtection.install()
        guard Thread.isMainThread else {
            return runCore(input: input, output: output, diagnostics: diagnostics)
        }
        // NSWorkspace delivers launch completion through the main run loop. Keep
        // that loop serviceable while framing remains on its independent reader.
        let completion = NativeHostRunCompletion()
        DispatchQueue(label: "surfaceloom.macos-host.reader").async {
            completion.finish(self.runCore(input: input, output: output, diagnostics: diagnostics))
        }
        while completion.result() == nil {
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
        return completion.result() ?? 1
    }

    private func runCore(
        input: FileHandle,
        output: FileHandle,
        diagnostics: FileHandle
    ) -> Int32 {
        let writer = NativeWireOutput(output)
        let safeDiagnostics = NativeSafeDiagnostics(diagnostics)
        let connection = NativeConnectionState(closeInput: { try? input.close() })
        let reader = NativeFrameReader()
        var accepting = true

        do {
            while accepting, connection.mayWriteOrExecute {
                let chunk = input.availableData
                if chunk.isEmpty { break }
                for byte in chunk where connection.mayWriteOrExecute {
                    if let frame = try reader.append(byte) {
                        accepting = ingest(frame, writer: writer, diagnostics: safeDiagnostics, connection: connection)
                        if !accepting { break }
                    }
                }
            }
            if accepting, connection.mayWriteOrExecute, let finalFrame = try reader.finish() {
                _ = ingest(finalFrame, writer: writer, diagnostics: safeDiagnostics, connection: connection)
            }
        } catch let error as NativeProtocolError {
            _ = error
            safeDiagnostics.write(.invalidInput)
        } catch {
            safeDiagnostics.write(.inputFailure)
        }

        // EOF, deadline, and cancel only stop admission/cooperating work. We wait
        // for the serial executor; a non-cooperative handler can still prevent
        // return, and this shell never fabricates a stop or cleanup receipt.
        pending.wait()
        let cleanShutdown = dispatcher.shutdownBackend()
        return connection.didFailOutput || !cleanShutdown ? 1 : 0
    }

    private func ingest(
        _ frame: NativeWireFrame,
        writer: NativeWireOutput,
        diagnostics: NativeSafeDiagnostics,
        connection: NativeConnectionState
    ) -> Bool {
        if frame.bytes.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) { return true }
        let json: NativeJSONValue
        do {
            json = try NativeWireCodec.parseFrame(frame)
        } catch {
            diagnostics.write(.invalidInput)
            return false
        }
        guard NativeWireCodec.exactProtocolMarker(in: json) else {
            diagnostics.write(.ambiguousProtocol)
            return false
        }
        if let candidateID = NativeWireCodec.recoverableMessageID(in: json),
           dispatcher.isOutstanding(candidateID) {
            diagnostics.write(.duplicateRequest)
            return false
        }

        do {
            switch try NativeWireCodec.decodeMessage(json) {
            case let .cancel(cancel):
                dispatcher.cancel(cancel)
            case let .request(request):
                let prepared: NativePreparedRequest
                do {
                    prepared = try dispatcher.prepare(
                        request,
                        receivedUptimeNanoseconds: frame.receivedUptimeNanoseconds
                    )
                } catch let error as NativeProtocolError where error.code == "request_id_conflict" {
                    diagnostics.write(.duplicateRequest)
                    return false
                }
                enqueue(
                    { self.dispatcher.makeOutboundFrame(for: prepared) },
                    prepared: prepared,
                    writer: writer,
                    diagnostics: diagnostics,
                    connection: connection
                )
            case let .response(response):
                enqueue(
                    { Self.clientMessageFailure(id: response.id) },
                    writer: writer, diagnostics: diagnostics, connection: connection
                )
                return false
            }
            return true
        } catch let error as NativeProtocolError {
            guard let id = error.requestID ?? NativeWireCodec.recoverableMessageID(in: json) else {
                diagnostics.write(.invalidInput)
                return false
            }
            enqueue(
                { Self.schemaFailure(id: id, error: error) },
                writer: writer, diagnostics: diagnostics, connection: connection
            )
            return false
        } catch {
            diagnostics.write(.invalidInput)
            return false
        }
    }

    private func enqueue(
        _ frame: @escaping @Sendable () -> Data,
        prepared: NativePreparedRequest? = nil,
        writer: NativeWireOutput,
        diagnostics: NativeSafeDiagnostics,
        connection: NativeConnectionState
    ) {
        pending.enter()
        executor.async {
            defer {
                if let prepared { self.dispatcher.complete(prepared) }
                self.pending.leave()
            }
            guard connection.mayWriteOrExecute else { return }
            do {
                try writer.writeFrame(frame())
                if let prepared {
                    self.dispatcher.terminalWriteFinished(prepared, published: true)
                }
            }
            catch {
                if let prepared {
                    self.dispatcher.terminalWriteFinished(prepared, published: false)
                }
                if connection.failOutput() { diagnostics.write(.outputFailure) }
            }
        }
    }

    private static func schemaFailure(id: String, error: NativeProtocolError) -> Data {
        NativeWireCodec.encodeFailureOrEmergency(
            id: id,
            code: error.code,
            category: error.category,
            message: error.message
        )
    }

    private static func clientMessageFailure(id: String) -> Data {
        NativeWireCodec.encodeFailureOrEmergency(
            id: id,
            code: "invalid_message",
            category: .invalidRequest,
            message: "Clients may send only request or cancel frames."
        )
    }
}
