import ApplicationServices
import Foundation
import SurfaceLoomNativeProtocol

struct MacOSExecutableIdentity: Sendable {
    let processID: Int32
    let executableName: String
    let bundleIdentifier: String?
    let architecture: String
}

final class MacOSHostElement: @unchecked Sendable {
    let raw: AnyObject
    let nativeAX: AXUIElement?
    init(raw: AnyObject) {
        self.raw = raw
        nativeAX = nil
    }
    init(nativeAX: AXUIElement) {
        raw = nativeAX
        self.nativeAX = nativeAX
    }
}

enum MacOSIdentityStatus: Equatable, Sendable {
    case current
    case provenStopped
    case unconfirmed
}

struct MacOSAXSnapshot: Sendable {
    let identifier: String?
    let role: String
    let title: String?
    let value: String?
    let enabled: Bool?
    let focused: Bool?
    let processID: Int32
    let supportedActions: [String]

    var jsonValue: NativeJSONValue {
        .object([
            "identifier": identifier.map(NativeJSONValue.string) ?? .null,
            "role": .string(role),
            "title": title.map(NativeJSONValue.string) ?? .null,
            "value": value.map(NativeJSONValue.string) ?? .null,
            "enabled": enabled.map(NativeJSONValue.bool) ?? .null,
            "focused": focused.map(NativeJSONValue.bool) ?? .null,
            "processId": .number(Double(processID)),
            "supportedActions": .array(supportedActions.map(NativeJSONValue.string)),
        ])
    }
}

protocol MacOSHostPlatform: AnyObject, Sendable {
    var executableIdentity: MacOSExecutableIdentity { get }
    func accessibilityTrusted() -> Bool
    func validateLaunch(_ spec: MacOSLaunchSpec) throws
    func beginLaunch(
        _ spec: MacOSLaunchSpec,
        completion: @escaping @Sendable (Result<MacOSApplicationIdentity, NativeHostBackendError>) -> Void
    )
    func attach(processID: Int32) throws -> MacOSApplicationIdentity
    func identityStatus(_ application: MacOSApplicationIdentity) -> MacOSIdentityStatus
    func terminate(_ application: MacOSApplicationIdentity, force: Bool, timeoutMilliseconds: Int) -> Bool
    func rootElement(for application: MacOSApplicationIdentity) throws -> MacOSHostElement
    func findUnique(
        _ locator: MacOSAXLocator,
        under root: MacOSHostElement,
        application: MacOSApplicationIdentity,
        context: NativeHostExecutionContext
    ) throws -> MacOSHostElement
    func sameElement(_ lhs: MacOSHostElement, _ rhs: MacOSHostElement) -> Bool
    func snapshot(
        _ element: MacOSHostElement,
        application: MacOSApplicationIdentity,
        context: NativeHostExecutionContext
    ) throws -> MacOSAXSnapshot
    func validateAction(
        _ action: MacOSAXAction,
        on element: MacOSHostElement,
        context: NativeHostExecutionContext
    ) throws
    func perform(
        _ action: MacOSAXAction,
        value: String?,
        on element: MacOSHostElement,
        context: NativeHostExecutionContext
    ) throws
}

func macOSBackendError(
    _ code: String,
    _ category: NativeErrorCategory = .backend,
    _ message: String = "The macOS backend could not prove a successful result."
) -> NativeHostBackendError {
    NativeHostBackendError(code: code, category: category, safeMessage: message)
}
