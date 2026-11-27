public protocol MacOSComponent {
	var driver: MacOSApplicationDriver { get }
	init(driver: MacOSApplicationDriver)
}

public struct MacOSAppSession {
	public let driver: MacOSApplicationDriver

	public init(driver: MacOSApplicationDriver) {
		self.driver = driver
	}

	public func component<Component: MacOSComponent>(
		_ type: Component.Type = Component.self
	) -> Component {
		Component(driver: driver)
	}

	public var lifecycle: ApplicationLifecycleComponent { component() }
	public var windows: WindowComponent { component() }
	public var menus: MenuComponent { component() }
	public var dialogs: DialogComponent { component() }
	public var textInput: TextInputComponent { component() }
	public var collections: CollectionComponent { component() }
	public var fileDialog: NativeFileDialogComponent { component() }
}

/// `sessionInputProbe` defaults to the live window server session; inject one
/// only when the runner proves session readiness some other way.
public enum MacOSTestHarness {
	public static func withApplication(
		configuration: MacOSAppConfiguration,
		sessionInputProbe: MacOSSessionInputProbe = .live,
		_ body: (MacOSAppSession) throws -> Void
	) throws {
		try MacOSUIStateRecovery.requireProcessStateClean(for: configuration)
		let driver = MacOSApplicationDriver(configuration: configuration, sessionInputProbe: sessionInputProbe)
		try driver.launch()
		try MacOSUIStateRecovery.requireProcessStateClean(for: configuration)
		var bodyFailure: Error?
		do {
			try body(MacOSAppSession(driver: driver))
		} catch {
			bodyFailure = error
		}
		do {
			try driver.terminateAndRequireStopped()
		} catch {
			throw MacOSUIStateRecovery.markTainted(
				configuration: configuration,
				operationKey: "macos.owned-session.cleanup",
				originalFailure: bodyFailure ?? DesktopAutomationError.actionFailed(
					"The owned session body completed before cleanup failed"
				),
				cleanupFailure: error
			)
		}
		if let bodyFailure { throw bodyFailure }
	}

	public static func withAttachedApplication(
		configuration: MacOSAppConfiguration,
		sessionInputProbe: MacOSSessionInputProbe = .live,
		_ body: (MacOSAppSession) throws -> Void
	) throws {
		try MacOSUIStateRecovery.requireProcessStateClean(for: configuration)
		let driver = MacOSApplicationDriver(configuration: configuration, sessionInputProbe: sessionInputProbe)
		try driver.attachToRunningApplication()
		defer { driver.detach() }
		try MacOSUIStateRecovery.requireProcessStateClean(for: configuration)
		try body(MacOSAppSession(driver: driver))
	}
}
