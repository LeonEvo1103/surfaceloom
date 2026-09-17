import Foundation
import SurfaceLoomNativeProtocol

public final class NativeHostDispatcher: @unchecked Sendable {
    public typealias Handler = @Sendable (NativeRequest, NativeHostExecutionContext) throws -> NativeJSONValue
    public let descriptor: NativeHostDescriptor
    private let handler: Handler?
    private let backend: (any NativeHostBackend)?
    private let lock = NSLock()
    private var outstanding: [String: NativeCancellationState] = [:]
    private var operationIDs = Set<String>()
    private var backendShutdown = false
    private var backendShutdownResult: Bool?
    private let operationLimit = 100_000
    public init(descriptor: NativeHostDescriptor? = nil, handler: @escaping Handler = { _, _ in
        throw NativeHostBackendError(
            code: "method_not_found",
            category: .unsupported,
            safeMessage: "The requested method is not advertised."
        )
    }) {
        self.descriptor = descriptor ?? Self.shellDescriptor()
        self.handler = handler
        self.backend = nil
    }
    public init(backend: any NativeHostBackend) {
        descriptor = backend.descriptor
        handler = nil
        self.backend = backend
    }

    public static func shellDescriptor(hostInstanceID: String = "macos-\(UUID().uuidString.lowercased())") -> NativeHostDescriptor {
        NativeHostDescriptor(
            hostInstanceID: hostInstanceID, platform: "macos", backend: "stdio-shell",
            methods: [NativeMethodDescriptor(name: "host.handshake", intent: .observe, scopeKinds: ["bootstrap"])]
        )
    }

    public func prepare(_ request: NativeRequest, receivedUptimeNanoseconds: UInt64) throws -> NativePreparedRequest {
        let cancellation = NativeCancellationState()
        lock.lock()
        defer { lock.unlock() }
        guard outstanding[request.id] == nil else {
            throw NativeProtocolError(
                code: "request_id_conflict",
                category: .conflict,
                message: "An outstanding request already uses this id.",
                requestID: request.id
            )
        }
        outstanding[request.id] = cancellation
        return NativePreparedRequest(
            request: request,
            receivedUptimeNanoseconds: receivedUptimeNanoseconds,
            cancellation: cancellation
        )
    }

    public func cancel(_ cancellation: NativeCancel) {
        lock.lock()
        let state = outstanding[cancellation.requestID]
        lock.unlock()
        state?.cancel()
    }

    func isOutstanding(_ requestID: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return outstanding[requestID] != nil
    }

    func isCancellationRequested(_ requestID: String) -> Bool {
        lock.lock()
        let state = outstanding[requestID]
        lock.unlock()
        return state?.isCancelled == true
    }

    func shutdownBackend() -> Bool {
        let shouldRun = lock.withLock {
            guard !backendShutdown else { return false }
            backendShutdown = true
            return true
        }
        if shouldRun {
            let result = backend?.shutdown() ?? true
            lock.withLock { backendShutdownResult = result }
            return result
        }
        return lock.withLock { backendShutdownResult ?? false }
    }

    func terminalWriteFinished(_ prepared: NativePreparedRequest, published: Bool) {
        if !published || prepared.cancellation.isCancelled || prepared.deadline.isExpired() {
            _ = prepared.handleResponseExpired()
        }
    }

    public func makeOutboundFrame(for prepared: NativePreparedRequest) -> Data {
        var response = execute(prepared)
        var frame = encodeWithBoundedFallback(response, request: prepared.request)
        if response.isSuccess,
           prepared.cancellation.isCancelled || prepared.deadline.isExpired() {
            let cleanupOutcome = prepared.handleResponseExpired()
            response = failure(
                prepared.request,
                code: prepared.cancellation.isCancelled ? "request_cancelled" : "deadline_exceeded",
                category: prepared.cancellation.isCancelled ? .cancelled : .deadline,
                message: "The response could not be published before the request stopped.",
                outcome: cleanupOutcome ?? response.operation?.outcome
            )
            frame = encodeWithBoundedFallback(response, request: prepared.request)
        }
        return frame
    }

    func complete(_ prepared: NativePreparedRequest) {
        lock.lock()
        if outstanding[prepared.request.id] === prepared.cancellation {
            outstanding.removeValue(forKey: prepared.request.id)
        }
        lock.unlock()
    }

    private func execute(_ prepared: NativePreparedRequest) -> NativeResponse {
        let request = prepared.request
        var submitted = false
        do {
            try validateDispatch(request)
            try registerOperation(request)
            if prepared.cancellation.isCancelled {
                return failure(request, code: "request_cancelled", category: .cancelled,
                               message: "The request was cancelled before native submission.", outcome: .notExecuted)
            }
            if prepared.deadline.isExpired() {
                return failure(request, code: "deadline_exceeded", category: .deadline,
                               message: "The request deadline expired before native submission.", outcome: .notExecuted)
            }
            if request.call.name == "host.handshake", backend == nil {
                return NativeResponse(id: request.id, result: descriptor.jsonValue)
            }
            let context = NativeHostExecutionContext(
                cancellation: prepared.cancellation,
                deadline: prepared.deadline
            )
            let command: NativeHostBackendCommand
            if let backend {
                command = try backend.prepare(request: request, context: context)
            } else {
                command = NativeHostBackendCommand {
                    guard let handler = self.handler else {
                        throw NativeHostBackendError(
                            code: "host_internal_error", category: .internal,
                            safeMessage: "The macOS native host has no request handler."
                        )
                    }
                    return try handler(request, context)
                }
            }
            if prepared.cancellation.isCancelled || prepared.deadline.isExpired() {
                command.cancelBeforeSubmission()
                return failure(
                    request,
                    code: prepared.cancellation.isCancelled ? "request_cancelled" : "deadline_exceeded",
                    category: prepared.cancellation.isCancelled ? .cancelled : .deadline,
                    message: "The request stopped before native submission.",
                    outcome: .notExecuted
                )
            }
            try command.validateBeforeSubmission()
            if prepared.cancellation.isCancelled || prepared.deadline.isExpired() {
                command.cancelBeforeSubmission()
                return failure(
                    request,
                    code: prepared.cancellation.isCancelled ? "request_cancelled" : "deadline_exceeded",
                    category: prepared.cancellation.isCancelled ? .cancelled : .deadline,
                    message: "The request stopped before native submission.",
                    outcome: .notExecuted
                )
            }
            submitted = request.call.intent != .observe
            let result = try command.execute()
            prepared.setResponseExpiredHook { command.responseExpired() }
            if prepared.cancellation.isCancelled || prepared.deadline.isExpired() {
                return failure(request,
                               code: prepared.cancellation.isCancelled ? "request_cancelled" : "deadline_exceeded",
                               category: prepared.cancellation.isCancelled ? .cancelled : .deadline,
                               message: "The request stopped before terminal publication.",
                               outcome: submitted ? (prepared.handleResponseExpired() ?? .executed) : nil)
            }
            return NativeResponse(
                id: request.id,
                result: result,
                operation: request.call.operationID.map {
                    NativeOperationReceipt(operationID: $0, outcome: .executed)
                }
            )
        } catch let error as NativeProtocolError {
            return failure(request, code: error.code, category: error.category,
                           message: error.message, outcome: submitted ? .unknown : .notExecuted)
        } catch let error as NativeHostBackendError {
            return failure(request, code: error.code, category: error.category,
                           message: error.safeMessage, outcome: submitted ? .unknown : .notExecuted)
        } catch {
            return failure(request, code: "host_internal_error", category: .internal,
                           message: "The macOS native host failed unexpectedly.",
                           outcome: submitted ? .unknown : .notExecuted)
        }
    }

    private func validateDispatch(_ request: NativeRequest) throws {
        guard let method = descriptor.methods.first(where: { $0.name == request.call.name }) else {
            throw NativeProtocolError(code: "method_not_found", category: .unsupported,
                                      message: "The requested method is not advertised.", requestID: request.id)
        }
        guard method.intent == request.call.intent, method.scopeKinds.contains(request.call.scope.kind) else {
            throw NativeProtocolError(code: "method_contract_mismatch", category: .invalidRequest,
                                      message: "The call intent or scope does not match the advertised method descriptor.",
                                      requestID: request.id)
        }
        if request.call.scope != .bootstrap,
           request.call.scope.hostInstanceID != descriptor.hostInstanceID {
            throw NativeProtocolError(code: "host_instance_stale", category: .conflict,
                                      message: "The call targets a stale host instance.", requestID: request.id)
        }
    }

    private func registerOperation(_ request: NativeRequest) throws {
        guard let operationID = request.call.operationID else { return }
        lock.lock()
        defer { lock.unlock() }
        guard operationIDs.count < operationLimit else {
            throw NativeProtocolError(code: "operation_registry_full", category: .conflict,
                                      message: "The operation registry reached its safety limit.", requestID: request.id)
        }
        guard operationIDs.insert(operationID).inserted else {
            throw NativeProtocolError(code: "operation_id_reused", category: .conflict,
                                      message: "The operation id was already consumed.", requestID: request.id)
        }
    }

    private func encodeWithBoundedFallback(_ response: NativeResponse, request: NativeRequest) -> Data {
        do { return try NativeWireCodec.encode(.response(response)) }
        catch {
            let fallback = failure(request, code: "response_too_large", category: .internal,
                                   message: "The native response exceeded its bounded wire contract.",
                                   outcome: response.operation?.outcome)
            return NativeWireCodec.encodeFailureOrEmergency(
                id: fallback.id,
                code: fallback.error?.code ?? "host_internal_error",
                category: fallback.error?.category ?? .internal,
                message: fallback.error?.message ?? "The native host failed safely.",
                operation: fallback.operation
            )
        }
    }

    private func failure(
        _ request: NativeRequest,
        code: String,
        category: NativeErrorCategory,
        message: String,
        outcome: NativeOperationOutcome?
    ) -> NativeResponse {
        let receipt = request.call.operationID.map {
            NativeOperationReceipt(operationID: $0, outcome: outcome ?? .unknown)
        }
        let safe = receipt?.outcome == .notExecuted && code != "operation_id_reused"
        return NativeResponse(
            id: request.id,
            error: NativeWireError(code: code, category: category, message: message, retry: safe ? .safe : .never),
            operation: receipt
        )
    }
}
