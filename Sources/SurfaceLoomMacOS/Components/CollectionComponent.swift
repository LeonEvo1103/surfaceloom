public struct CollectionComponent: MacOSComponent {
	public let driver: MacOSApplicationDriver

	public init(driver: MacOSApplicationDriver) {
		self.driver = driver
	}

	public func count(_ items: MacOSAXLocator) -> Int {
		driver.findElements(items).count
	}

	public func select(_ item: MacOSAXLocator) throws {
		try driver.press(item)
	}
}
