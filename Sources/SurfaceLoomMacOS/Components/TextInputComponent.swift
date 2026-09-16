public struct TextInputComponent: MacOSComponent {
	public let driver: MacOSApplicationDriver

	public init(driver: MacOSApplicationDriver) {
		self.driver = driver
	}

	public func value(of field: MacOSAXLocator) throws -> String? {
		driver.stringValue(of: try driver.findElement(field))
	}

	public func setValue(_ value: String, on field: MacOSAXLocator) throws {
		try driver.setValue(value, on: field)
	}

	public func requireEnabled(_ field: MacOSAXLocator) throws {
		let element = try driver.findElement(field)
		guard driver.isEnabled(element) else {
			throw DesktopAutomationError.actionFailed("\(field.name) is disabled")
		}
	}
}
