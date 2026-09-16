public struct MenuComponent: MacOSComponent {
	public let driver: MacOSApplicationDriver

	public init(driver: MacOSApplicationDriver) {
		self.driver = driver
	}

	public func open(_ menu: MacOSAXLocator) throws {
		try driver.press(menu)
	}

	public func requireItem(_ item: MacOSAXLocator) throws {
		_ = try driver.findElement(item)
	}

	public func invokeItem(_ item: MacOSAXLocator) throws {
		try driver.press(item)
	}

	public func chooseFirstTransientItem() throws {
		try driver.pressShortcut(.arrowDown)
		try driver.pressShortcut(.enter)
	}
}
