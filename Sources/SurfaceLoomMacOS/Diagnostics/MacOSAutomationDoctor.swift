import Foundation

public struct MacOSAutomationDoctor {
	public static let schemaVersion = "1"
	public static let appBundleCheck = "macos.appBundle"
	public static let accessibilityCheck = "macos.accessibilityTrust"
	public static let runnerIdentityCheck = "macos.runnerIdentity"
	public static let firstAuthorizationCheck = "macos.tcc.firstAuthorization"

	private let configuration: MacOSAppConfiguration
	private let probe: () -> MacOSDoctorInputs

	public init(configuration: MacOSAppConfiguration) {
		self.configuration = configuration
		probe = { Self.liveInputs(for: configuration) }
	}

	init(
		configuration: MacOSAppConfiguration,
		probe: @escaping () -> MacOSDoctorInputs
	) {
		self.configuration = configuration
		self.probe = probe
	}

	public func run() -> MacOSDoctorReport {
		Self.evaluate(configuration: configuration, inputs: probe())
	}

	static func evaluate(
		configuration: MacOSAppConfiguration,
		inputs: MacOSDoctorInputs
	) -> MacOSDoctorReport {
		let checks = [
			bundleCheck(configuration: configuration, exists: inputs.appBundleExists),
			accessibilityTrustCheck(trusted: inputs.accessibilityTrusted),
			runnerCheck(pid: inputs.runnerPID, executablePath: inputs.runnerExecutablePath),
			firstAuthorizationBoundary(),
		]
		let blocked = checks.contains {
			$0.required && ($0.status == .fail || $0.status == .unsupported)
		}
		return MacOSDoctorReport(
			schemaVersion: schemaVersion,
			platform: "macos",
			targetId: configuration.bundleIdentifier,
			generatedAt: inputs.checkedAt,
			readOnly: true,
			overall: overallStatus(for: checks),
			canStartSession: !blocked,
			checks: checks
		)
	}

	private static func liveInputs(for configuration: MacOSAppConfiguration) -> MacOSDoctorInputs {
		MacOSDoctorInputs(
			appBundleExists: FileManager.default.fileExists(atPath: configuration.appURL.path),
			accessibilityTrusted: MacOSApplicationDriver.isAccessibilityTrusted(prompt: false),
			runnerPID: ProcessInfo.processInfo.processIdentifier,
			runnerExecutablePath: runnerExecutablePath(),
			checkedAt: Date()
		)
	}

	private static func bundleCheck(
		configuration: MacOSAppConfiguration,
		exists: Bool
	) -> MacOSDoctorCheck {
		MacOSDoctorCheck(
			id: appBundleCheck,
			status: exists ? .pass : .fail,
			summary: exists
				? "The application bundle exists."
				: "The application bundle does not exist.",
			required: true,
			details: ["path": configuration.appURL.path],
			remediation: exists ? nil : "Build or install the target app at the configured path."
		)
	}

	private static func accessibilityTrustCheck(trusted: Bool) -> MacOSDoctorCheck {
		MacOSDoctorCheck(
			id: accessibilityCheck,
			status: trusted ? .pass : .fail,
			summary: trusted
				? "The current automation runner has Accessibility access."
				: "The current automation runner does not have Accessibility access.",
			required: true,
			details: [
				"checkedProcess": "runner",
				"promptRequested": "false",
				"trusted": String(trusted),
			],
			remediation: trusted
				? nil
				: "Grant this runner Accessibility access manually, then run doctor again."
		)
	}

	private static func runnerCheck(
		pid: Int32,
		executablePath: String?
	) -> MacOSDoctorCheck {
		let path = executablePath?.trimmingCharacters(in: .whitespacesAndNewlines)
		let identified = pid > 0 && !(path?.isEmpty ?? true)
		return MacOSDoctorCheck(
			id: runnerIdentityCheck,
			status: identified ? .pass : .warn,
			summary: identified
				? "The automation runner identity is available."
				: "The automation runner executable path could not be resolved.",
			required: false,
			details: [
				"pid": String(pid),
				"executablePath": path ?? "",
			],
			remediation: identified
				? nil
				: "Run tests from a stable executable path before granting Accessibility access."
		)
	}

	private static func firstAuthorizationBoundary() -> MacOSDoctorCheck {
		MacOSDoctorCheck(
			id: firstAuthorizationCheck,
			status: .unsupported,
			summary: "Automatic first-time TCC authorization is intentionally unsupported.",
			required: false,
			details: [
				"autoAccept": "false",
				"promptRequested": "false",
				"tccMutation": "false",
			],
			remediation: "Grant or deny the macOS prompt manually in a dedicated test environment."
		)
	}

	private static func overallStatus(
		for checks: [MacOSDoctorCheck]
	) -> MacOSDoctorStatus {
		if checks.contains(where: { $0.required && $0.status == .fail }) { return .fail }
		if checks.contains(where: { $0.required && $0.status == .unsupported }) {
			return .unsupported
		}
		if checks.contains(where: { $0.status == .warn }) { return .warn }
		return .pass
	}

	private static func runnerExecutablePath() -> String? {
		if let executableURL = Bundle.main.executableURL {
			return executableURL.resolvingSymlinksInPath().path
		}
		guard let argument = CommandLine.arguments.first, !argument.isEmpty else { return nil }
		return URL(fileURLWithPath: argument).standardizedFileURL.path
	}
}

struct MacOSDoctorInputs: Sendable {
	let appBundleExists: Bool
	let accessibilityTrusted: Bool
	let runnerPID: Int32
	let runnerExecutablePath: String?
	let checkedAt: Date
}
