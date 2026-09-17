import Foundation
import SurfaceLoomNativeProtocol
@testable import SurfaceLoomMacOSHost

final class FakeMacOSHostPlatform: MacOSHostPlatform, @unchecked Sendable {
    final class Element: NSObject {
        let name: String
        init(_ name: String) { self.name = name }
    }

    let lock = NSLock()
    var trusted = true
    var identityStatusValue: MacOSIdentityStatus = .current
    var current: Bool {
        get { lock.withLock { identityStatusValue == .current } }
        set { lock.withLock { identityStatusValue = newValue ? .current : .provenStopped } }
    }
    var terminateSucceeds = true
    var launchBegins = 0
    var terminateCalls = 0
    var terminatedProcessIDs: [Int32] = []
    var failPerform = false
    var performed: [MacOSAXAction] = []
    var pendingLaunch: (@Sendable (Result<MacOSApplicationIdentity, NativeHostBackendError>) -> Void)?
    var onBeginLaunch: (() -> Void)?
    var onRoot: (() -> Void)?
    var rootError: NativeHostBackendError?
    var attachError: NativeHostBackendError?
    var findError: NativeHostBackendError?
    var validateActionCalls = 0
    var onValidateAction: (() -> Void)?
    var onTerminate: (() -> Void)?
    let application = MacOSApplicationIdentity(
        processID: 4_242, startSeconds: 100, startMicroseconds: 2, bundleIdentifier: "test.fixture"
    )
    let root = Element("root")
    let field = Element("field")
    let duplicate = Element("duplicate")
    var findMap: [String: [Element]] = [:]

    var executableIdentity: MacOSExecutableIdentity {
        MacOSExecutableIdentity(processID: 99, executableName: "fixture-host",
                                bundleIdentifier: "test.host", architecture: "arm64")
    }

    func accessibilityTrusted() -> Bool { lock.withLock { trusted } }
    func validateLaunch(_ spec: MacOSLaunchSpec) throws {
        guard spec.path.hasPrefix("/") else { throw MacOSPayload.invalid() }
    }
    func beginLaunch(
        _ spec: MacOSLaunchSpec,
        completion: @escaping @Sendable (Result<MacOSApplicationIdentity, NativeHostBackendError>) -> Void
    ) {
        _ = spec
        lock.withLock {
            launchBegins += 1
            pendingLaunch = completion
        }
        onBeginLaunch?()
    }
    func completeLaunch(_ result: Result<MacOSApplicationIdentity, NativeHostBackendError>? = nil) {
        let callback = lock.withLock { pendingLaunch }
        callback?(result ?? .success(application))
    }
    func attach(processID: Int32) throws -> MacOSApplicationIdentity {
        if let attachError { throw attachError }
        guard processID == application.processID, identityStatus(application) == .current else {
            throw macOSBackendError("session_target_not_found", .notFound)
        }
        return application
    }
    func identityStatus(_ application: MacOSApplicationIdentity) -> MacOSIdentityStatus {
        lock.withLock {
            guard application == self.application else { return .provenStopped }
            return identityStatusValue
        }
    }
    func terminate(_ application: MacOSApplicationIdentity, force: Bool, timeoutMilliseconds: Int) -> Bool {
        _ = force; _ = timeoutMilliseconds
        onTerminate?()
        return lock.withLock {
            terminateCalls += 1
            terminatedProcessIDs.append(application.processID)
            guard application == self.application else { return false }
            guard identityStatusValue == .current else {
                return identityStatusValue == .provenStopped
            }
            if terminateSucceeds {
                identityStatusValue = .provenStopped
                return true
            }
            return false
        }
    }
    func rootElement(for application: MacOSApplicationIdentity) throws -> MacOSHostElement {
        onRoot?()
        if let rootError { throw rootError }
        guard identityStatus(application) == .current else { throw macOSBackendError("session_stale", .notFound) }
        return MacOSHostElement(raw: root)
    }
    func findUnique(
        _ locator: MacOSAXLocator,
        under root: MacOSHostElement,
        application: MacOSApplicationIdentity,
        context: NativeHostExecutionContext
    ) throws -> MacOSHostElement {
        _ = root
        if context.isCancellationRequested { throw macOSBackendError("request_cancelled", .cancelled) }
        if context.deadline.isExpired() { throw macOSBackendError("deadline_exceeded", .deadline) }
        if let findError { throw findError }
        guard identityStatus(application) == .current else { throw macOSBackendError("session_stale", .notFound) }
        let key = locator.identifier ?? locator.title ?? locator.role ?? ""
        let matches = lock.withLock { findMap[key] ?? [] }
        guard !matches.isEmpty else { throw macOSBackendError("element_not_found", .notFound) }
        guard matches.count == 1 else { throw macOSBackendError("element_ambiguous", .conflict) }
        return MacOSHostElement(raw: matches[0])
    }
    func sameElement(_ lhs: MacOSHostElement, _ rhs: MacOSHostElement) -> Bool { lhs.raw === rhs.raw }
    func snapshot(
        _ element: MacOSHostElement,
        application: MacOSApplicationIdentity,
        context: NativeHostExecutionContext
    ) throws -> MacOSAXSnapshot {
        guard !context.isCancellationRequested, !context.deadline.isExpired(),
              identityStatus(application) == .current, let value = element.raw as? Element else {
            throw macOSBackendError("element_handle_stale", .notFound)
        }
        return MacOSAXSnapshot(identifier: value.name, role: "AXTextField", title: value.name,
                               value: "", enabled: true, focused: false,
                               processID: application.processID,
                               supportedActions: ["focus", "press", "setValue"])
    }
    func validateAction(
        _ action: MacOSAXAction,
        on element: MacOSHostElement,
        context: NativeHostExecutionContext
    ) throws {
        _ = action
        guard !context.isCancellationRequested, !context.deadline.isExpired() else {
            throw macOSBackendError("deadline_exceeded", .deadline)
        }
        lock.withLock { validateActionCalls += 1 }
        onValidateAction?()
        guard element.raw is Element else { throw macOSBackendError("action_not_supported", .unsupported) }
    }
    func perform(
        _ action: MacOSAXAction,
        value: String?,
        on element: MacOSHostElement,
        context: NativeHostExecutionContext
    ) throws {
        _ = value
        guard !context.isCancellationRequested, !context.deadline.isExpired() else {
            throw macOSBackendError("deadline_exceeded", .deadline)
        }
        guard element.raw is Element else { throw macOSBackendError("ax_action_unconfirmed") }
        try lock.withLock {
            if failPerform { throw macOSBackendError("ax_action_unconfirmed") }
            performed.append(action)
        }
    }
}

extension NativeHostContractTests {
    func execute(_ dispatcher: NativeHostDispatcher, _ request: NativeRequest) throws -> NativeResponse {
        let prepared = try dispatcher.prepare(
            request, receivedUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds
        )
        defer { dispatcher.complete(prepared) }
        let data = dispatcher.makeOutboundFrame(for: prepared)
        return try responseLines(data).first!
    }

    func call(
        id: String,
        method: String,
        intent: NativeOperationIntent,
        scope: NativeScope,
        payload: NativeJSONObject = [:],
        operationID: String? = nil,
        timeout: Int = 1_000
    ) -> NativeRequest {
        NativeRequest(id: id, timeoutMilliseconds: timeout,
                      call: NativeCall(name: method, intent: intent, scope: scope,
                                       payload: payload, operationID: operationID))
    }
}
