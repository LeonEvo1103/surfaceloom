import AppKit
import ApplicationServices
import Foundation

public enum MacOSAXPresence: Sendable, Equatable {
	case present
	case absent
}

extension MacOSApplicationDriver {
	/// A complete, throwing accessibility-tree observation. Unlike convenience lookup APIs,
	/// provider/root failures are never collapsed into an empty result.
	public func observePresence(_ locator: MacOSAXLocator) throws -> MacOSAXPresence {
		try strictlyObservedElements(locator, limit: 1).isEmpty ? .absent : .present
	}

	/// Resolves one complete observation using the locator's explicit match policy.
	/// This does not poll; callers that retry retain control over indeterminate reads.
	public func strictlyObservedElement(_ locator: MacOSAXLocator) throws -> AXUIElement? {
		let matches = try strictlyObservedElements(
			locator,
			limit: MacOSAXMatchResolver.lookupLimit(for: locator.matchPolicy)
		)
		return try MacOSAXMatchResolver.resolve(matches, for: locator)
	}

	public func strictlyObservedElements(
		_ locator: MacOSAXLocator,
		limit: Int = 5_000
	) throws -> [AXUIElement] {
		precondition(limit > 0)
		try MacOSAXMatchResolver.validate(locator)
		guard let root = try strictRootElement(for: locator.scope) else {
			if locator.scope == .focusedMenu { return [] }
			throw DesktopAutomationError.actionFailed(
				"The accessibility observation root was indeterminate"
			)
		}
		return try strictMatchingElements(locator, root: root, limit: limit)
	}

	public func strictlyObservedElements(
		_ locator: MacOSAXLocator,
		within root: AXUIElement,
		limit: Int = 5_000
	) throws -> [AXUIElement] {
		precondition(limit > 0)
		try MacOSAXMatchResolver.validate(locator)
		return try strictMatchingElements(locator, root: root, limit: limit)
	}

	public func strictAccessibleText(of element: AXUIElement) throws -> [String] {
		try strictAccessibleTextValues(of: element).sorted()
	}

	public func strictStringValue(of element: AXUIElement) throws -> String? {
		try strictString(kAXValueAttribute, of: element)
	}

	public func strictEnabledValue(of element: AXUIElement) throws -> Bool? {
		try strictBoolean(kAXEnabledAttribute, of: element)
	}

	public func strictARIACurrentValue(of element: AXUIElement) throws -> String? {
		try strictString("AXARIACurrent", of: element)
	}

	public func strictParent(of element: AXUIElement) throws -> AXUIElement? {
		try strictElement(kAXParentAttribute, of: element)
	}

	public func strictRoleValue(of element: AXUIElement) throws -> String? {
		try strictString(kAXRoleAttribute, of: element)
	}

	public func strictSubroleValue(of element: AXUIElement) throws -> String? {
		try strictString(kAXSubroleAttribute, of: element)
	}

	public func strictModalValue(of element: AXUIElement) throws -> Bool? {
		try strictBoolean(kAXModalAttribute, of: element)
	}

	/// Requires multiple complete absence observations. One empty or failed provider read is
	/// insufficient proof that a reversible surface has closed.
	public func requireStableAbsence(
		_ locator: MacOSAXLocator,
		consecutiveObservations: Int = 2,
		timeout: TimeInterval? = nil
	) throws {
		precondition(consecutiveObservations > 0)
		let deadline = Date().addingTimeInterval(max(timeout ?? locator.timeout, 0))
		var consecutive = 0
		repeat {
			switch try observePresence(locator) {
			case .absent:
				consecutive += 1
				if consecutive >= consecutiveObservations { return }
			case .present:
				consecutive = 0
			}
			RunLoop.current.run(until: Date().addingTimeInterval(0.05))
		} while Date() < deadline
		throw DesktopAutomationError.actionFailed(
			"Stable absence was not proven for \(locator.name)"
		)
	}

}
