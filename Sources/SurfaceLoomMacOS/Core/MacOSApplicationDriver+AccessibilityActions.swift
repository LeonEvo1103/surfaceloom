import AppKit
import ApplicationServices
import Foundation

extension MacOSApplicationDriver {
	public func press(_ element: AXUIElement) throws {
		let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
		guard result == .success else {
			throw DesktopAutomationError.actionFailed(
				"AXPress failed with code \(result.rawValue)"
			)
		}
	}

	public func press(_ locator: MacOSAXLocator, timeout: TimeInterval? = nil) throws {
		try press(findElement(locator, timeout: timeout))
	}

	/// Brackets caller-supplied safety checks with two strict resolutions of the
	/// same semantic target. The action is attempted once only after the target
	/// identity remains current and AXEnabled is explicitly readable as true.
	public func pressCurrentEnabled(
		_ locator: MacOSAXLocator,
		timeout: TimeInterval? = nil,
		whileStillCurrent validateCurrentState: () throws -> Void
	) throws {
		try requireActiveApplicationForCheckedAction()
		let expected = try findElement(locator, timeout: timeout)
		try validateCurrentState()
		let current = try findElement(locator, timeout: min(timeout ?? locator.timeout, 0.1))
		guard CFEqual(expected, current) else {
			throw DesktopAutomationError.actionFailed(
				"The enabled action target changed while its current UI state was validated"
			)
		}
		guard try strictEnabledValue(of: current) == true else {
			throw DesktopAutomationError.actionFailed(
				"The current action target did not expose an explicit enabled state"
			)
		}
		try requireActiveApplicationForCheckedAction()
		try press(current)
	}

	private func requireActiveApplicationForCheckedAction() throws {
		guard let application,
			isProcessAlive(application.processIdentifier),
			application.isActive
		else {
			throw DesktopAutomationError.actionFailed(
				"The checked action requires the bound application to remain active"
			)
		}
	}

	public func clickCenter(of element: AXUIElement) throws {
		guard let application, isProcessAlive(application.processIdentifier) else {
			throw DesktopAutomationError.actionFailed(
				"Cannot click an element because \(configuration.displayName) is not running"
			)
		}
		_ = application.activate()
		guard wait(until: { application.isActive }, timeout: 3) else {
			throw DesktopAutomationError.actionFailed(
				"\(configuration.displayName) did not become active before element click"
			)
		}

		guard let position = point(attribute: kAXPositionAttribute, of: element),
			let size = size(attribute: kAXSizeAttribute, of: element),
			size.width > 0,
			size.height > 0
		else {
			throw DesktopAutomationError.actionFailed(
				"AX element did not expose a clickable position and size"
			)
		}
		let center = CGPoint(
			x: position.x + size.width / 2,
			y: position.y + size.height / 2
		)
		guard
			let source = CGEventSource(stateID: .hidSystemState),
			let down = CGEvent(
				mouseEventSource: source,
				mouseType: .leftMouseDown,
				mouseCursorPosition: center,
				mouseButton: .left
			),
			let up = CGEvent(
				mouseEventSource: source,
				mouseType: .leftMouseUp,
				mouseCursorPosition: center,
				mouseButton: .left
			)
		else {
			throw DesktopAutomationError.actionFailed("Could not create mouse events")
		}
		down.post(tap: .cghidEventTap)
		Thread.sleep(forTimeInterval: 0.05)
		up.post(tap: .cghidEventTap)
	}

	public func focus(_ element: AXUIElement) throws {
		let result = AXUIElementSetAttributeValue(
			element,
			kAXFocusedAttribute as CFString,
			kCFBooleanTrue
		)
		guard result == .success else {
			throw DesktopAutomationError.actionFailed(
				"AX focus update failed with code \(result.rawValue)"
			)
		}
	}

	public func setValue(_ value: String, on element: AXUIElement) throws {
		let result = AXUIElementSetAttributeValue(
			element,
			kAXValueAttribute as CFString,
			value as CFTypeRef
		)
		guard result == .success else {
			throw DesktopAutomationError.actionFailed(
				"AXValue update failed with code \(result.rawValue)"
			)
		}
	}

	public func setValue(_ value: String, on locator: MacOSAXLocator) throws {
		try setValue(value, on: findElement(locator))
	}

	public func pressShortcut(_ shortcut: MacOSShortcut) throws {
		guard let application, isProcessAlive(application.processIdentifier) else {
			throw DesktopAutomationError.actionFailed(
				"Cannot send a shortcut because \(configuration.displayName) is not running"
			)
		}
		_ = application.activate()
		guard wait(until: { application.isActive }, timeout: 3) else {
			throw DesktopAutomationError.actionFailed(
				"\(configuration.displayName) did not become active"
			)
		}
		guard
			let source = CGEventSource(stateID: .hidSystemState),
			let keyDown = CGEvent(
				keyboardEventSource: source,
				virtualKey: shortcut.virtualKey,
				keyDown: true
			),
			let keyUp = CGEvent(
				keyboardEventSource: source,
				virtualKey: shortcut.virtualKey,
				keyDown: false
			)
		else {
			throw DesktopAutomationError.actionFailed("Could not create keyboard events")
		}
		keyDown.flags = shortcut.flags
		keyUp.flags = shortcut.flags
		keyDown.post(tap: .cghidEventTap)
		Thread.sleep(forTimeInterval: 0.05)
		keyUp.post(tap: .cghidEventTap)
	}

	private func point(attribute: String, of element: AXUIElement) -> CGPoint? {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
			let value,
			CFGetTypeID(value) == AXValueGetTypeID()
		else { return nil }
		var point = CGPoint.zero
		guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
		return point
	}

	private func size(attribute: String, of element: AXUIElement) -> CGSize? {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
			let value,
			CFGetTypeID(value) == AXValueGetTypeID()
		else { return nil }
		var size = CGSize.zero
		guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
		return size
	}
}
