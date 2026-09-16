import Foundation

public struct MacOSQuitMenuContract: Sendable {
	public let applicationMenu: MacOSAXLocator
	public let quitItem: MacOSAXLocator

	public init(applicationMenu: MacOSAXLocator, quitItem: MacOSAXLocator) {
		self.applicationMenu = applicationMenu
		self.quitItem = quitItem
	}
}

public struct ApplicationLifecycleComponent: MacOSComponent {
	public let driver: MacOSApplicationDriver

	public init(driver: MacOSApplicationDriver) {
		self.driver = driver
	}

	public var isRunning: Bool { driver.isRunning }

	public func closePrimaryWindow(using shortcut: MacOSShortcut = .commandW) throws {
		try driver.pressShortcut(shortcut)
	}

	public func reopenApplication() throws {
		try driver.reopen()
	}

	public func requestQuit(using contract: MacOSQuitMenuContract) throws {
		try driver.press(contract.applicationMenu)
		let quitItem = try driver.findElement(contract.quitItem)
		try driver.requireCommandOnlyShortcut("q", on: quitItem)
		try driver.press(quitItem)
	}

	public func waitUntilTerminated(timeout: TimeInterval = 8) -> Bool {
		driver.waitForTermination(timeout: timeout)
	}
}
