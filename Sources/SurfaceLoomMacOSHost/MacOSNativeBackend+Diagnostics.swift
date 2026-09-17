import Foundation
import SurfaceLoomNativeProtocol

extension MacOSNativeBackend {
    func doctor() -> NativeJSONValue {
        let identity = platform.executableIdentity
        let trusted = platform.accessibilityTrusted()
        return .object([
            "schemaVersion": .string("1"),
            "protocolVersion": .string(NativeProtocolV1.version),
            "platform": .string("macos"),
            "readOnly": .bool(true),
            "canStartSession": .bool(trusted),
            "host": hostIdentityJSON(identity),
            "accessibility": .object([
                "trusted": .bool(trusted),
                "promptRequested": .bool(false),
                "automaticAuthorization": .bool(false),
            ]),
        ])
    }

    func capabilities() -> NativeJSONValue {
        let identity = platform.executableIdentity
        return .object([
            "protocolVersion": .string(NativeProtocolV1.version),
            "platform": .string("macos"),
            "architecture": .string(identity.architecture),
            "host": hostIdentityJSON(identity),
            "accessibilityTrusted": .bool(platform.accessibilityTrusted()),
            "capabilities": .array([
                "macos.session.ownedLaunch", "macos.session.borrowedAttach",
                "macos.ax.strictFind", "macos.ax.press", "macos.ax.setValue", "macos.ax.focus",
            ].map(NativeJSONValue.string)),
        ])
    }

    private func hostIdentityJSON(_ identity: MacOSExecutableIdentity) -> NativeJSONValue {
        .object([
            "hostInstanceId": .string(descriptor.hostInstanceID),
            "processId": .number(Double(identity.processID)),
            "executableName": .string(identity.executableName),
            "bundleIdentifier": identity.bundleIdentifier.map(NativeJSONValue.string) ?? .null,
        ])
    }
}
