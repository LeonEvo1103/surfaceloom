import Foundation

public enum MacOSStartupExpectation: Sendable, Equatable {
	case process
	case onScreenWindow
}

public struct MacOSLaunchProfile: Sendable {
	public let environment: [String: String]
	public let cleanupDirectories: [URL]

	public init(
		environment: [String: String] = [:],
		cleanupDirectories: [URL] = []
	) {
		self.environment = environment
		self.cleanupDirectories = cleanupDirectories
	}

	public static let inherited = Self()
}

public struct MacOSAppConfiguration: Sendable {
	public let appURL: URL
	public let bundleIdentifier: String
	public let displayName: String
	public let launchTimeout: TimeInterval
	public let runLiveUI: Bool
	public let startupExpectation: MacOSStartupExpectation
	public let launchProfile: MacOSLaunchProfile

	public init(
		appURL: URL,
		bundleIdentifier: String,
		displayName: String,
		launchTimeout: TimeInterval = 30,
		runLiveUI: Bool = false,
		startupExpectation: MacOSStartupExpectation = .onScreenWindow,
		launchProfile: MacOSLaunchProfile = .inherited
	) {
		self.appURL = appURL
		self.bundleIdentifier = bundleIdentifier
		self.displayName = displayName
		self.launchTimeout = launchTimeout
		self.runLiveUI = runLiveUI
		self.startupExpectation = startupExpectation
		self.launchProfile = launchProfile
	}

	public static func fromEnvironment(
		defaults: Self,
		prefix: String = "DESKTOP_TEST",
		environment: [String: String] = ProcessInfo.processInfo.environment
	) -> Self {
		let path = environment["\(prefix)_APP_PATH"] ?? defaults.appURL.path
		return Self(
			appURL: URL(fileURLWithPath: path).standardizedFileURL,
			bundleIdentifier: environment["\(prefix)_BUNDLE_ID"] ?? defaults.bundleIdentifier,
			displayName: environment["\(prefix)_APP_NAME"] ?? defaults.displayName,
			launchTimeout: TimeInterval(environment["\(prefix)_TIMEOUT"] ?? "")
				?? defaults.launchTimeout,
			runLiveUI: environment["\(prefix)_RUN"] == "1",
			startupExpectation: defaults.startupExpectation,
			launchProfile: defaults.launchProfile
		)
	}

	public func withLaunchProfile(_ launchProfile: MacOSLaunchProfile) -> Self {
		Self(
			appURL: appURL,
			bundleIdentifier: bundleIdentifier,
			displayName: displayName,
			launchTimeout: launchTimeout,
			runLiveUI: runLiveUI,
			startupExpectation: startupExpectation,
			launchProfile: launchProfile
		)
	}
}
