import AppKit
import ApplicationServices
import Foundation

extension MacOSApplicationDriver {
	public static func isAccessibilityTrusted(prompt: Bool = false) -> Bool {
		guard prompt else { return AXIsProcessTrusted() }
		let options = [
			kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
		] as CFDictionary
		return AXIsProcessTrustedWithOptions(options)
	}

	public func findElement(
		_ locator: MacOSAXLocator,
		timeout: TimeInterval? = nil
	) throws -> AXUIElement {
		try MacOSAXMatchResolver.validate(locator)
		var matches: [AXUIElement] = []
		let found = wait(until: {
			matches = self.matchingElements(
				locator,
				limit: MacOSAXMatchResolver.lookupLimit(for: locator.matchPolicy)
			)
			return MacOSAXMatchResolver.hasResolvableMatch(
				count: matches.count,
				policy: locator.matchPolicy
			)
		}, timeout: timeout ?? locator.timeout)

		guard found, let match = try MacOSAXMatchResolver.resolve(matches, for: locator) else {
			throw DesktopAutomationError.elementNotFound(locator)
		}
		return match
	}

	public func findElements(_ locator: MacOSAXLocator) -> [AXUIElement] {
		matchingElements(locator, limit: 5_000)
	}

	public func findElements(
		_ locator: MacOSAXLocator,
		within root: AXUIElement
	) -> [AXUIElement] {
		matchingElements(locator, root: root, limit: 5_000)
	}

	public func exists(_ locator: MacOSAXLocator, timeout: TimeInterval = 0.1) -> Bool {
		wait(
			until: { !self.matchingElements(locator, limit: 1).isEmpty },
			timeout: timeout
		)
	}

	public func stringValue(of element: AXUIElement) -> String? {
		string(attribute: kAXValueAttribute, of: element)
	}

	public func integerValue(of element: AXUIElement) -> Int? {
		integer(attribute: kAXValueAttribute, of: element)
	}

	public func menuItemMarkCharacter(of element: AXUIElement) -> String? {
		string(attribute: kAXMenuItemMarkCharAttribute, of: element)
	}

	public func ariaCurrentValue(of element: AXUIElement) -> String? {
		// Keep compatibility with SDKs that predate the public AXWebConstants
		// declaration. A runtime without the attribute returns nil and callers
		// fail closed.
		string(attribute: "AXARIACurrent", of: element)
	}

	public func isModal(_ element: AXUIElement) -> Bool {
		boolean(attribute: kAXModalAttribute, of: element) ?? false
	}

	public func subroleValue(of element: AXUIElement) -> String? {
		string(attribute: kAXSubroleAttribute, of: element)
	}

	public func roleValue(of element: AXUIElement) -> String? {
		string(attribute: kAXRoleAttribute, of: element)
	}

	public func parent(of element: AXUIElement) -> AXUIElement? {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(
			element,
			kAXParentAttribute as CFString,
			&value
		) == .success else {
			return nil
		}
		guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
			return nil
		}
		return (value as! AXUIElement)
	}

	public func accessibleText(of element: AXUIElement) -> [String] {
		accessibleLabels(of: element).sorted()
	}

	public func isEnabled(_ element: AXUIElement) -> Bool {
		enabledValue(of: element) ?? true
	}

	/// Returns nil when the provider does not expose a trustworthy AXEnabled value.
	/// State-changing callers can therefore fail closed instead of inheriting the
	/// compatibility default used by `isEnabled`.
	public func enabledValue(of element: AXUIElement) -> Bool? {
		boolean(attribute: kAXEnabledAttribute, of: element)
	}

	public func waitForElementToDisappear(
		_ locator: MacOSAXLocator,
		timeout: TimeInterval? = nil
	) -> Bool {
		wait(
			until: { !self.exists(locator, timeout: 0.05) },
			timeout: timeout ?? locator.timeout
		)
	}

	public func requireCommandOnlyShortcut(
		_ character: String,
		on element: AXUIElement
	) throws {
		guard normalize(string(attribute: kAXMenuItemCmdCharAttribute, of: element) ?? "")
			== normalize(character) else {
			throw DesktopAutomationError.actionFailed(
				"Menu item is not bound to Command-\(character.uppercased())"
			)
		}
		guard integer(attribute: kAXMenuItemCmdModifiersAttribute, of: element) == 0 else {
			throw DesktopAutomationError.actionFailed(
				"Menu item has additional shortcut modifiers"
			)
		}
	}

	private func matchingElements(
		_ locator: MacOSAXLocator,
		limit: Int
	) -> [AXUIElement] {
		guard let root = rootElement(for: locator.scope) else { return [] }
		return matchingElements(locator, root: root, limit: limit)
	}

	private func matchingElements(
		_ locator: MacOSAXLocator,
		root: AXUIElement,
		limit: Int
	) -> [AXUIElement] {
		let identifiers = Set(locator.identifiers.map(normalize))
		let labels = Set(locator.labels.map(normalize))
		let roles = Set(locator.roles)

		let candidates = breadthFirstElements(root: root, limit: 5_000).filter { element in
			roles.isEmpty || roles.contains(role(of: element))
		}
		return MacOSAXMatchResolver.prioritizedMatches(
			candidates,
			identifiers: identifiers,
			labels: labels,
			identifierOf: { element in
				normalize(string(attribute: kAXIdentifierAttribute, of: element) ?? "")
			},
			labelsOf: { element in
				Set(accessibleLabels(of: element).map(normalize))
			}
		).prefix(limit).map { $0 }
	}

	private func breadthFirstElements(root: AXUIElement, limit: Int) -> [AXUIElement] {
		var result: [AXUIElement] = []
		var queue: [AXUIElement] = [root]
		var cursor = 0
		while cursor < queue.count, result.count < limit {
			let current = queue[cursor]
			cursor += 1
			result.append(current)
			queue.append(contentsOf: elements(attribute: kAXChildrenAttribute, of: current))
		}
		return result
	}

	private func elements(attribute: String, of element: AXUIElement) -> [AXUIElement] {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
			return []
		}
		return value as? [AXUIElement] ?? []
	}

	private func string(attribute: String, of element: AXUIElement) -> String? {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
			return nil
		}
		return value as? String
	}

	private func integer(attribute: String, of element: AXUIElement) -> Int? {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
			return nil
		}
		return (value as? NSNumber)?.intValue
	}

	private func boolean(attribute: String, of element: AXUIElement) -> Bool? {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
			return nil
		}
		return (value as? NSNumber)?.boolValue
	}

	private func role(of element: AXUIElement) -> String {
		string(attribute: kAXRoleAttribute, of: element) ?? ""
	}

	private func accessibleLabels(of element: AXUIElement) -> Set<String> {
		let attributes = [
			kAXTitleAttribute,
			kAXDescriptionAttribute,
			kAXHelpAttribute,
			kAXValueAttribute,
		]
		return Set(attributes.compactMap { string(attribute: $0, of: element) })
	}

	private func normalize(_ value: String) -> String {
		value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	}
}
