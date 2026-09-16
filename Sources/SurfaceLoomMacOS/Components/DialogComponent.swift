import Foundation

public struct DialogComponent: MacOSComponent {
	public let driver: MacOSApplicationDriver

	public init(driver: MacOSApplicationDriver) {
		self.driver = driver
	}

	public func isPresented(_ sentinel: MacOSAXLocator, timeout: TimeInterval = 1) -> Bool {
		driver.exists(sentinel, timeout: timeout)
	}

	public func invoke(_ control: MacOSAXLocator) throws {
		try driver.press(control)
	}

	public func waitUntilDismissed(
		_ sentinel: MacOSAXLocator,
		timeout: TimeInterval = 8
	) -> Bool {
		driver.waitForElementToDisappear(sentinel, timeout: timeout)
	}
}
