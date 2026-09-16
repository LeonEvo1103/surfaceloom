import Foundation
import Testing
@testable import SurfaceLoomMacOS

@Suite("macOS automation doctor contracts")
struct MacOSAutomationDoctorTests {
	private let configuration = MacOSAppConfiguration(
		appURL: URL(fileURLWithPath: "/Applications/Sample.app"),
		bundleIdentifier: "com.example.sample",
		displayName: "Sample"
	)

	@Test("Doctor is read-only and reports a healthy runner")
	func healthyRunner() throws {
		let checkedAt = Date(timeIntervalSince1970: 1_700_000_000)
		let report = makeReport(
			inputs: MacOSDoctorInputs(
				appBundleExists: true,
				accessibilityTrusted: true,
				runnerPID: 42,
				runnerExecutablePath: "/tmp/SurfaceLoomRunner",
				checkedAt: checkedAt
			)
		)

		#expect(report.schemaVersion == "1")
		#expect(report.platform == "macos")
		#expect(report.targetId == "com.example.sample")
		#expect(report.generatedAt == checkedAt)
		#expect(report.readOnly)
		#expect(report.overall == .pass)
		#expect(report.canStartSession)

		let app = try check(MacOSAutomationDoctor.appBundleCheck, in: report)
		#expect(app.status == .pass)
		#expect(app.required)
		#expect(app.details["path"] == "/Applications/Sample.app")

		let accessibility = try check(
			MacOSAutomationDoctor.accessibilityCheck,
			in: report
		)
		#expect(accessibility.status == .pass)
		#expect(accessibility.details["promptRequested"] == "false")
		#expect(accessibility.details["checkedProcess"] == "runner")

		let runner = try check(MacOSAutomationDoctor.runnerIdentityCheck, in: report)
		#expect(runner.status == .pass)
		#expect(runner.details["pid"] == "42")
		#expect(runner.details["executablePath"] == "/tmp/SurfaceLoomRunner")

		let tcc = try check(MacOSAutomationDoctor.firstAuthorizationCheck, in: report)
		#expect(tcc.status == .unsupported)
		#expect(!tcc.required)
		#expect(tcc.details["autoAccept"] == "false")
		#expect(tcc.details["promptRequested"] == "false")
		#expect(tcc.details["tccMutation"] == "false")
	}

	@Test("Required failures block a session without prompting")
	func blockedRunner() throws {
		let report = makeReport(
			inputs: MacOSDoctorInputs(
				appBundleExists: false,
				accessibilityTrusted: false,
				runnerPID: 84,
				runnerExecutablePath: nil,
				checkedAt: Date(timeIntervalSince1970: 1_700_000_001)
			)
		)

		#expect(report.overall == .fail)
		#expect(!report.canStartSession)
		#expect(try check(MacOSAutomationDoctor.appBundleCheck, in: report).status == .fail)
		let accessibility = try check(
			MacOSAutomationDoctor.accessibilityCheck,
			in: report
		)
		#expect(accessibility.status == .fail)
		#expect(accessibility.details["promptRequested"] == "false")
		#expect(
			try check(MacOSAutomationDoctor.runnerIdentityCheck, in: report).status == .warn
		)

		let observedStatuses = Set(
			makeHealthyStatuses() + report.checks.map(\.status)
		)
		#expect(observedStatuses == Set(MacOSDoctorStatus.allCases))
	}

	private func makeReport(inputs: MacOSDoctorInputs) -> MacOSDoctorReport {
		MacOSAutomationDoctor(configuration: configuration, probe: { inputs }).run()
	}

	private func check(
		_ id: String,
		in report: MacOSDoctorReport
	) throws -> MacOSDoctorCheck {
		try #require(report.checks.first { $0.id == id })
	}

	private func makeHealthyStatuses() -> [MacOSDoctorStatus] {
		makeReport(
			inputs: MacOSDoctorInputs(
				appBundleExists: true,
				accessibilityTrusted: true,
				runnerPID: 42,
				runnerExecutablePath: "/tmp/SurfaceLoomRunner",
				checkedAt: Date(timeIntervalSince1970: 1_700_000_000)
			)
		).checks.map(\.status)
	}
}
