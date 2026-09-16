import Foundation

public struct WindowComponent: MacOSComponent {
	public let driver: MacOSApplicationDriver

	public init(driver: MacOSApplicationDriver) {
		self.driver = driver
	}

	public var onScreenCount: Int { driver.onScreenWindowCount }

	public func waitUntilVisible(timeout: TimeInterval = 8) -> Bool {
		driver.waitForOnScreenWindow(timeout: timeout)
	}

	public func waitUntilHidden(timeout: TimeInterval = 8) -> Bool {
		driver.waitForNoOnScreenWindows(timeout: timeout)
	}
}
