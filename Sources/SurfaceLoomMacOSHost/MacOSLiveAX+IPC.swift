import ApplicationServices
import Foundation

extension MacOSLivePlatform {
    static let maximumTraversalNodes = 5_000
    static let maximumChildrenPerNode = 1_024

    func traverse(
        from root: AXUIElement,
        context: NativeHostExecutionContext,
        visit: (AXUIElement) throws -> Void
    ) throws {
        try MacOSBoundedTraversal.walk(
            root: root,
            maximumNodes: Self.maximumTraversalNodes,
            maximumChildren: Self.maximumChildrenPerNode,
            context: context,
            hash: { Int(CFHash($0)) },
            equal: { CFEqual($0, $1) },
            children: { try self.children($0, context: context) },
            visit: visit
        )
    }

    func children(
        _ element: AXUIElement,
        context: NativeHostExecutionContext
    ) throws -> [AXUIElement] {
        try messagingTimeout.configure(element, context: context)
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
        if error == .noValue || error == .attributeUnsupported { return [] }
        guard error == .success, let values = value as? [AXUIElement],
              values.count <= Self.maximumChildrenPerNode else {
            throw macOSBackendError("ax_children_unavailable", .backend,
                                    "The AX child relationship could not be read safely.")
        }
        return values
    }

    func optionalString(
        _ attribute: String,
        _ element: AXUIElement,
        context: NativeHostExecutionContext
    ) throws -> String? {
        let value = try optionalAttribute(attribute, element, context: context)
        guard value == nil || value is String else { throw attributeUnavailable() }
        return value as? String
    }

    func requiredString(
        _ attribute: String,
        _ element: AXUIElement,
        context: NativeHostExecutionContext
    ) throws -> String {
        guard let value = try optionalString(attribute, element, context: context), !value.isEmpty else {
            throw staleElement()
        }
        return value
    }

    func optionalBoolean(
        _ attribute: String,
        _ element: AXUIElement,
        context: NativeHostExecutionContext
    ) throws -> Bool? {
        let value = try optionalAttribute(attribute, element, context: context)
        guard value == nil || value is NSNumber else { throw attributeUnavailable() }
        return (value as? NSNumber)?.boolValue
    }

    func optionalAttribute(
        _ attribute: String,
        _ element: AXUIElement,
        context: NativeHostExecutionContext
    ) throws -> CFTypeRef? {
        try messagingTimeout.configure(element, context: context)
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        if error == .noValue || error == .attributeUnsupported { return nil }
        guard error == .success else { throw attributeUnavailable() }
        return value
    }

    func labels(
        _ element: AXUIElement,
        context: NativeHostExecutionContext
    ) throws -> [String] {
        try [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute]
            .compactMap { try optionalString($0, element, context: context) }
    }

    func copyActionNames(
        _ element: AXUIElement,
        context: NativeHostExecutionContext
    ) throws -> [String] {
        try messagingTimeout.configure(element, context: context)
        var names: CFArray?
        let error = AXUIElementCopyActionNames(element, &names)
        if error == .noValue || error == .attributeUnsupported { return [] }
        guard error == .success, let values = names as? [String],
              values.count <= Self.maximumChildrenPerNode else { throw attributeUnavailable() }
        return values
    }

    func settable(
        _ attribute: String,
        _ element: AXUIElement,
        context: NativeHostExecutionContext
    ) throws -> Bool {
        try messagingTimeout.configure(element, context: context)
        var result = DarwinBoolean(false)
        let error = AXUIElementIsAttributeSettable(element, attribute as CFString, &result)
        if error == .noValue || error == .attributeUnsupported { return false }
        guard error == .success else { throw attributeUnavailable() }
        return result.boolValue
    }

    func requireRunning(_ context: NativeHostExecutionContext) throws {
        if context.isCancellationRequested {
            throw macOSBackendError("request_cancelled", .cancelled, "The AX traversal was cancelled.")
        }
        if context.deadline.isExpired() {
            throw macOSBackendError("deadline_exceeded", .deadline, "The AX traversal exceeded its deadline.")
        }
    }

    func requireCurrent(_ application: MacOSApplicationIdentity) throws {
        switch identityStatus(application) {
        case .current: return
        case .provenStopped: throw staleElement()
        case .unconfirmed:
            throw macOSBackendError("application_identity_unconfirmed", .backend,
                                    "The application identity could not be revalidated.")
        }
    }

    func ax(_ element: MacOSHostElement) throws -> AXUIElement {
        guard let value = optionalAX(element) else { throw staleElement() }
        return value
    }
    func optionalAX(_ element: MacOSHostElement) -> AXUIElement? { element.nativeAX }
    func staleElement() -> NativeHostBackendError {
        macOSBackendError("element_handle_stale", .notFound, "The AX element handle is no longer valid.")
    }
    func attributeUnavailable() -> NativeHostBackendError {
        macOSBackendError("ax_attribute_unavailable", .backend, "An AX attribute could not be read safely.")
    }
    func unsupportedAction() -> NativeHostBackendError {
        macOSBackendError("action_not_supported", .unsupported,
                          "The AX element does not support the requested semantic action.")
    }
}
