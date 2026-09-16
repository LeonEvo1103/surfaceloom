import ApplicationServices

extension MacOSApplicationDriver {
	func rootElement(for scope: MacOSAXScope) -> AXUIElement? {
		switch scope {
		case .application:
			return applicationElement()
		case .desktop:
			return AXUIElementCreateSystemWide()
		case .focusedMenu:
			guard let application, isProcessAlive(application.processIdentifier) else {
				return nil
			}
			let systemWide = AXUIElementCreateSystemWide()
			guard let focusedApplication = element(
				attribute: kAXFocusedApplicationAttribute,
				of: systemWide
			) else { return nil }
			var focusedApplicationPID: pid_t = 0
			guard AXUIElementGetPid(focusedApplication, &focusedApplicationPID) == .success,
				focusedApplicationPID == application.processIdentifier,
				var current = element(
					attribute: kAXFocusedUIElementAttribute,
					of: systemWide
				)
			else { return nil }
			for _ in 0..<32 {
				if string(attribute: kAXRoleAttribute, of: current) == kAXMenuRole as String {
					return current
				}
				guard let parent = element(attribute: kAXParentAttribute, of: current) else {
					return nil
				}
				current = parent
			}
			return nil
		case .menuBar:
			guard let application = applicationElement() else { return nil }
			var value: CFTypeRef?
			guard AXUIElementCopyAttributeValue(
				application,
				kAXMenuBarAttribute as CFString,
				&value
			) == .success, let value,
				CFGetTypeID(value) == AXUIElementGetTypeID()
			else { return nil }
			return unsafeDowncast(value as AnyObject, to: AXUIElement.self)
		}
	}

	private func applicationElement() -> AXUIElement? {
		guard let application, isProcessAlive(application.processIdentifier) else { return nil }
		return AXUIElementCreateApplication(application.processIdentifier)
	}

	private func element(attribute: String, of root: AXUIElement) -> AXUIElement? {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(
			root,
			attribute as CFString,
			&value
		) == .success, let value,
			CFGetTypeID(value) == AXUIElementGetTypeID()
		else { return nil }
		return unsafeDowncast(value as AnyObject, to: AXUIElement.self)
	}

	private func string(attribute: String, of element: AXUIElement) -> String? {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(
			element,
			attribute as CFString,
			&value
		) == .success else { return nil }
		return value as? String
	}
}
