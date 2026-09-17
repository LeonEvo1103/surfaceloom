import ApplicationServices
import Foundation

extension MacOSLivePlatform {
    func rootElement(for application: MacOSApplicationIdentity) throws -> MacOSHostElement {
        try requireCurrent(application)
        let root = AXUIElementCreateApplication(application.processID)
        guard AXUIElementSetMessagingTimeout(root, 1.0) == .success else {
            throw macOSBackendError("ax_messaging_timeout_unavailable", .backend,
                                    "The AX messaging timeout could not be configured safely.")
        }
        return MacOSHostElement(nativeAX: root)
    }

    func findUnique(
        _ locator: MacOSAXLocator,
        under root: MacOSHostElement,
        application: MacOSApplicationIdentity,
        context: NativeHostExecutionContext
    ) throws -> MacOSHostElement {
        try requireCurrent(application)
        var identifiers = MatchAccumulator()
        var fallbacks = MatchAccumulator()
        try traverse(from: ax(root), context: context) { element in
            if let role = locator.role,
               !exact(try optionalString(kAXRoleAttribute, element, context: context), role) { return }
            if let identifier = locator.identifier,
               exact(try optionalString(kAXIdentifierAttribute, element, context: context), identifier) {
                identifiers.add(element)
            }
            if let title = locator.title {
                if try labels(element, context: context).contains(where: { exact($0, title) }) {
                    fallbacks.add(element)
                }
            } else if locator.identifier == nil {
                fallbacks.add(element)
            }
        }
        let selected = identifiers.count > 0 ? identifiers : fallbacks
        guard selected.count > 0, let element = selected.first else {
            throw macOSBackendError("element_not_found", .notFound,
                                    "No AX element matched the strict locator.")
        }
        guard selected.count == 1 else {
            throw macOSBackendError("element_ambiguous", .conflict,
                                    "The strict AX locator matched more than one element.")
        }
        return MacOSHostElement(nativeAX: element)
    }

    func sameElement(_ lhs: MacOSHostElement, _ rhs: MacOSHostElement) -> Bool {
        guard let lhs = optionalAX(lhs), let rhs = optionalAX(rhs) else { return false }
        return CFEqual(lhs, rhs)
    }

    func snapshot(
        _ element: MacOSHostElement,
        application: MacOSApplicationIdentity,
        context: NativeHostExecutionContext
    ) throws -> MacOSAXSnapshot {
        try requireRunning(context)
        try requireCurrent(application)
        let raw = try ax(element)
        try messagingTimeout.configure(raw, context: context)
        var processID: pid_t = 0
        guard AXUIElementGetPid(raw, &processID) == .success,
              processID == application.processID else { throw staleElement() }
        let actionNames = try copyActionNames(raw, context: context)
        var actions: [String] = []
        if actionNames.contains(kAXPressAction as String) { actions.append(MacOSAXAction.press.rawValue) }
        if try settable(kAXValueAttribute, raw, context: context) {
            actions.append(MacOSAXAction.setValue.rawValue)
        }
        if try settable(kAXFocusedAttribute, raw, context: context) {
            actions.append(MacOSAXAction.focus.rawValue)
        }
        return MacOSAXSnapshot(
            identifier: try optionalString(kAXIdentifierAttribute, raw, context: context),
            role: try requiredString(kAXRoleAttribute, raw, context: context),
            title: try labels(raw, context: context).first,
            value: try optionalString(kAXValueAttribute, raw, context: context),
            enabled: try optionalBoolean(kAXEnabledAttribute, raw, context: context),
            focused: try optionalBoolean(kAXFocusedAttribute, raw, context: context),
            processID: processID,
            supportedActions: actions.sorted()
        )
    }

    func validateAction(
        _ action: MacOSAXAction,
        on element: MacOSHostElement,
        context: NativeHostExecutionContext
    ) throws {
        let raw = try ax(element)
        guard try optionalBoolean(kAXEnabledAttribute, raw, context: context) == true else {
            throw unsupportedAction()
        }
        switch action {
        case .press:
            guard try copyActionNames(raw, context: context).contains(kAXPressAction as String) else {
                throw unsupportedAction()
            }
        case .setValue:
            guard try settable(kAXValueAttribute, raw, context: context) else { throw unsupportedAction() }
        case .focus:
            guard try settable(kAXFocusedAttribute, raw, context: context) else { throw unsupportedAction() }
        }
    }

    func perform(
        _ action: MacOSAXAction,
        value: String?,
        on element: MacOSHostElement,
        context: NativeHostExecutionContext
    ) throws {
        let raw = try ax(element)
        try messagingTimeout.configure(raw, context: context)
        let result: AXError
        switch action {
        case .press:
            result = AXUIElementPerformAction(raw, kAXPressAction as CFString)
        case .setValue:
            guard let value else { throw MacOSPayload.invalid() }
            result = AXUIElementSetAttributeValue(raw, kAXValueAttribute as CFString, value as CFTypeRef)
        case .focus:
            result = AXUIElementSetAttributeValue(raw, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        }
        guard result == .success else {
            throw macOSBackendError("ax_action_unconfirmed", .backend,
                                    "The AX action did not return a successful completion status.")
        }
    }

    private func exact(_ lhs: String?, _ rhs: String?) -> Bool {
        guard let lhs, let rhs else { return lhs == nil && rhs == nil }
        return lhs.utf8.elementsEqual(rhs.utf8)
    }
}

private struct MatchAccumulator {
    private(set) var count = 0
    private(set) var first: AXUIElement?
    mutating func add(_ element: AXUIElement) {
        count += 1
        if first == nil { first = element }
    }
}
