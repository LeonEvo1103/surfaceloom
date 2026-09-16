import AppKit
import ApplicationServices
import Foundation

extension MacOSApplicationDriver {
	func strictMatchingElements(
		_ locator: MacOSAXLocator,
		root: AXUIElement,
		limit: Int
	) throws -> [AXUIElement] {
		let identifiers = Set(locator.identifiers.map(strictNormalize))
		let labels = Set(locator.labels.map(strictNormalize))
		let roles = Set(locator.roles)
		let allCandidates = try strictBreadthFirstElements(root: root, limit: 5_000)
		var candidates: [AXUIElement] = []
		for candidate in allCandidates {
			if roles.isEmpty {
				candidates.append(candidate)
				continue
			}
			let role = try strictString(kAXRoleAttribute, of: candidate) ?? ""
			if roles.contains(role) { candidates.append(candidate) }
		}

		if !identifiers.isEmpty {
			let matches = try candidates.filter {
				identifiers.contains(strictNormalize(
					try strictString(kAXIdentifierAttribute, of: $0) ?? ""
				))
			}
			if !matches.isEmpty { return Array(matches.prefix(limit)) }
		}
		if !labels.isEmpty {
			let matches = try candidates.filter {
				!labels.isDisjoint(with: try strictAccessibleLabels(of: $0))
			}
			return Array(matches.prefix(limit))
		}
		return identifiers.isEmpty ? Array(candidates.prefix(limit)) : []
	}

	func strictBreadthFirstElements(root: AXUIElement, limit: Int) throws -> [AXUIElement] {
		var result: [AXUIElement] = []
		var queue: [AXUIElement] = [root]
		var cursor = 0
		while cursor < queue.count, result.count < limit {
			let current = queue[cursor]
			cursor += 1
			result.append(current)
			queue.append(contentsOf: try strictElements(kAXChildrenAttribute, of: current))
		}
		guard cursor == queue.count else {
			throw DesktopAutomationError.actionFailed(
				"Accessibility observation exceeded its fixed tree limit"
			)
		}
		return result
	}

	func strictRootElement(for scope: MacOSAXScope) throws -> AXUIElement? {
		switch scope {
		case .application:
			guard let application,
				isProcessAlive(application.processIdentifier),
				application.isActive
			else {
				throw DesktopAutomationError.actionFailed(
					"Accessibility observation requires a running bound application"
				)
			}
			return AXUIElementCreateApplication(application.processIdentifier)
		case .desktop:
			return AXUIElementCreateSystemWide()
		case .menuBar:
			guard let root = try strictRootElement(for: .application) else { return nil }
			return try strictElement(kAXMenuBarAttribute, of: root)
		case .focusedMenu:
			return try strictFocusedMenu()
		}
	}

	func strictFocusedMenu() throws -> AXUIElement? {
		guard let application,
			isProcessAlive(application.processIdentifier),
			application.isActive
		else {
			throw DesktopAutomationError.actionFailed(
				"Focused-menu observation requires a running bound application"
			)
		}
		let systemWide = AXUIElementCreateSystemWide()
		guard let focusedApplication = try strictElement(
			kAXFocusedApplicationAttribute,
			of: systemWide
		) else {
			throw DesktopAutomationError.actionFailed(
				"The focused application could not be observed"
			)
		}
		var focusedPID: pid_t = 0
		guard AXUIElementGetPid(focusedApplication, &focusedPID) == .success else {
			throw DesktopAutomationError.actionFailed(
				"Focused application identity could not be observed"
			)
		}
		guard focusedPID == application.processIdentifier else {
			throw DesktopAutomationError.actionFailed(
				"The bound application was not the focused accessibility application"
			)
		}
		guard var current = try strictElement(
			kAXFocusedUIElementAttribute,
			of: systemWide
		) else { return nil }
		for _ in 0..<32 {
			if try strictString(kAXRoleAttribute, of: current) == kAXMenuRole as String {
				return current
			}
			guard let parent = try strictElement(kAXParentAttribute, of: current) else {
				return nil
			}
			current = parent
		}
		throw DesktopAutomationError.actionFailed(
			"Focused-menu ancestry exceeded its fixed depth limit"
		)
	}

	func strictAccessibleLabels(of element: AXUIElement) throws -> Set<String> {
		Set(try strictAccessibleTextValues(of: element).map(strictNormalize))
	}

	func strictAccessibleTextValues(of element: AXUIElement) throws -> Set<String> {
		let attributes = [
			kAXTitleAttribute, kAXDescriptionAttribute,
			kAXHelpAttribute, kAXValueAttribute,
		]
		var labels: Set<String> = []
		for attribute in attributes {
			if attribute == kAXValueAttribute {
				if let value = try strictAttribute(
					attribute, of: element, allowUnsupported: true
				) as? String {
					labels.insert(value)
				}
			} else if let value = try strictString(attribute, of: element) {
				labels.insert(value)
			}
		}
		return labels
	}

	func strictElements(_ attribute: String, of element: AXUIElement) throws -> [AXUIElement] {
		guard let value = try strictAttribute(
			attribute, of: element, allowUnsupported: true
		) else { return [] }
		guard let elements = value as? [AXUIElement] else {
			throw DesktopAutomationError.actionFailed(
				"Accessibility children returned an unexpected value type"
			)
		}
		return elements
	}

	func strictElement(_ attribute: String, of element: AXUIElement) throws -> AXUIElement? {
		guard let value = try strictAttribute(attribute, of: element) else { return nil }
		guard CFGetTypeID(value) == AXUIElementGetTypeID() else {
			throw DesktopAutomationError.actionFailed(
				"Accessibility relationship returned an unexpected value type"
			)
		}
		return unsafeDowncast(value as AnyObject, to: AXUIElement.self)
	}

	func strictString(_ attribute: String, of element: AXUIElement) throws -> String? {
		guard let value = try strictAttribute(
			attribute, of: element, allowUnsupported: true
		) else { return nil }
		guard let string = value as? String else {
			throw DesktopAutomationError.actionFailed(
				"Accessibility string attribute returned an unexpected value type"
			)
		}
		return string
	}

	func strictBoolean(_ attribute: String, of element: AXUIElement) throws -> Bool? {
		guard let value = try strictAttribute(
			attribute, of: element, allowUnsupported: true
		) else { return nil }
		guard let number = value as? NSNumber else {
			throw DesktopAutomationError.actionFailed(
				"Accessibility boolean attribute returned an unexpected value type"
			)
		}
		return number.boolValue
	}

	func strictAttribute(
		_ attribute: String,
		of element: AXUIElement,
		allowUnsupported: Bool = false
	) throws -> CFTypeRef? {
		var value: CFTypeRef?
		let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
		switch result {
		case .success:
			guard let value else {
				throw DesktopAutomationError.actionFailed(
					"Accessibility returned success without an attribute value"
				)
			}
			return value
		case .noValue:
			return nil
		case .attributeUnsupported where allowUnsupported:
			return nil
		default:
			throw DesktopAutomationError.actionFailed(
				"Accessibility observation failed with code \(result.rawValue)"
			)
		}
	}

	func strictNormalize(_ value: String) -> String {
		value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	}
}
