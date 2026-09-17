import Foundation
import SurfaceLoomNativeProtocol

final class MacOSNativeBackend: NativeHostBackend, @unchecked Sendable {
    let descriptor: NativeHostDescriptor
    let registry: MacOSOwnershipRegistry
    let platform: any MacOSHostPlatform

    init(
        hostInstanceID: String = "macos-\(UUID().uuidString.lowercased())",
        platform: any MacOSHostPlatform = MacOSLivePlatform(),
        registry: MacOSOwnershipRegistry = MacOSOwnershipRegistry()
    ) {
        self.platform = platform
        self.registry = registry
        descriptor = NativeHostDescriptor(
            hostInstanceID: hostInstanceID, platform: "macos", backend: "ax",
            methods: MacOSHostMethod.advertised
        )
    }

    func prepare(
        request: NativeRequest,
        context: NativeHostExecutionContext
    ) throws -> NativeHostBackendCommand {
        switch request.call.name {
        case MacOSHostMethod.handshake:
            try MacOSPayload.handshake(request.call.payload)
            return NativeHostBackendCommand { self.descriptor.jsonValue }
        case MacOSHostMethod.doctor:
            try MacOSPayload.empty(request.call.payload)
            return NativeHostBackendCommand { self.doctor() }
        case MacOSHostMethod.capabilities:
            try MacOSPayload.empty(request.call.payload)
            return NativeHostBackendCommand { self.capabilities() }
        case MacOSHostMethod.launch:
            return try prepareLaunch(request.call.payload, context: context)
        case MacOSHostMethod.attach:
            return try prepareAttach(request.call.payload)
        case MacOSHostMethod.release:
            try MacOSPayload.empty(request.call.payload)
            return try prepareRelease(request.call.scope)
        case MacOSHostMethod.terminate:
            try MacOSPayload.empty(request.call.payload)
            return try prepareTerminate(request.call.scope, context: context)
        case MacOSHostMethod.find:
            return try prepareFind(request.call.scope, payload: request.call.payload, context: context)
        case MacOSHostMethod.get:
            try MacOSPayload.empty(request.call.payload)
            return try prepareGet(request.call.scope, context: context)
        case MacOSHostMethod.action:
            return try prepareAction(request.call.scope, payload: request.call.payload, context: context)
        default:
            throw macOSBackendError("method_not_found", .unsupported,
                                    "The requested method is not advertised.")
        }
    }

    func requireAccessibility() throws {
        guard platform.accessibilityTrusted() else {
            throw macOSBackendError("accessibility_permission_denied", .permissionDenied,
                                    "The running macOS host does not have Accessibility permission.")
        }
    }

    func sessionID(_ scope: NativeScope) throws -> String {
        guard case let .session(_, sessionID) = scope else { throw MacOSPayload.invalid() }
        return sessionID
    }

    func sessionJSON(_ session: MacOSSessionRecord) -> NativeJSONValue {
        .object([
            "hostInstanceId": .string(descriptor.hostInstanceID),
            "sessionId": .string(session.sessionID),
            "ownership": .string(session.ownership.rawValue),
            "surface": .string("application"),
            "root": handleJSON(sessionID: session.sessionID, handleID: session.rootHandleID),
        ])
    }

    func handleJSON(sessionID: String, handleID: String) -> NativeJSONValue {
        .object([
            "hostInstanceId": .string(descriptor.hostInstanceID),
            "sessionId": .string(sessionID),
            "handleId": .string(handleID),
        ])
    }
}
