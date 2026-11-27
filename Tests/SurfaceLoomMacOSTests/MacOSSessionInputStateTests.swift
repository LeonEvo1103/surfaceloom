import Foundation
import Testing
@testable import SurfaceLoomMacOS

@Suite("macOS session input state")
struct MacOSSessionInputStateTests {
	private let console = MacOSSessionInputState.onConsoleKey
	private let loginDone = MacOSSessionInputState.loginDoneKey
	private let locked = MacOSSessionInputState.screenLockedKey

	@Test("An unlocked console session without the lock key is available")
	func unlockedConsoleIsAvailable() {
		let state = MacOSSessionInputState.classify(
			sessionDictionary: [console: true, loginDone: true]
		)
		#expect(state == .available)
		#expect(state.permitsSyntheticInput)
		#expect(
			MacOSSessionInputState.classify(
				sessionDictionary: [console: true, loginDone: true, locked: false]
			) == .available
		)
	}

	@Test("A locked console session is screenLocked")
	func lockedConsoleIsLocked() {
		let state = MacOSSessionInputState.classify(
			sessionDictionary: [console: true, loginDone: true, locked: true]
		)
		#expect(state == .screenLocked)
		#expect(!state.permitsSyntheticInput)
	}

	@Test("An off-console session is notOnConsole even when also locked")
	func offConsoleWins() {
		for dictionary: [String: Any] in [
			[console: false, loginDone: true],
			[console: false, loginDone: true, locked: true],
		] {
			#expect(MacOSSessionInputState.classify(sessionDictionary: dictionary) == .notOnConsole)
		}
	}

	@Test("Unreadable or malformed sessions are unknown, never available")
	func unreadableIsUnknown() {
		let cases: [[String: Any]?] = [
			nil,
			[:],
			[loginDone: true, locked: false],
			[console: "yes", loginDone: true],
			[console: 2, loginDone: true],
			[console: true],
			[console: true, loginDone: false],
			[console: true, loginDone: true, locked: "no"],
		]
		for dictionary in cases {
			let state = MacOSSessionInputState.classify(sessionDictionary: dictionary)
			guard case .unknown = state else {
				Issue.record("Expected unknown for \(String(describing: dictionary)), got \(state)")
				continue
			}
			#expect(state.code == "unknown")
			#expect(!state.permitsSyntheticInput)
		}
	}

	@Test("Doctor maps each session state to a status with remediation")
	func doctorMapping() {
		let expectations: [(MacOSSessionInputState, MacOSDoctorStatus)] = [
			(.available, .pass),
			(.screenLocked, .fail),
			(.notOnConsole, .fail),
			(.unknown(reason: "probe"), .warn),
		]
		for (state, status) in expectations {
			let check = MacOSAutomationDoctor.sessionInputReadiness(state)
			#expect(check.id == MacOSAutomationDoctor.sessionInputCheck)
			#expect(check.status == status)
			#expect(check.required)
			#expect(check.details["state"] == state.code)
			#expect((check.remediation == nil) == (state == .available))
		}
		let unknown = MacOSAutomationDoctor.sessionInputReadiness(.unknown(reason: "probe"))
		#expect(unknown.details["reason"] == "probe")
		#expect(unknown.details["syntheticInput"] == "refused")
	}

	@Test("Doctor report blocks on lock but only warns on unknown")
	func doctorReportImpact() {
		let configuration = MacOSAppConfiguration(
			appURL: URL(fileURLWithPath: "/Applications/Sample.app"),
			bundleIdentifier: "com.example.sample",
			displayName: "Sample"
		)
		func report(_ state: MacOSSessionInputState) -> MacOSDoctorReport {
			MacOSAutomationDoctor.evaluate(
				configuration: configuration,
				inputs: MacOSDoctorInputs(
					appBundleExists: true,
					accessibilityTrusted: true,
					runnerPID: 42,
					runnerExecutablePath: "/tmp/SurfaceLoomRunner",
					sessionInput: state,
					checkedAt: Date(timeIntervalSince1970: 1_700_000_000)
				)
			)
		}
		for state in [MacOSSessionInputState.screenLocked, .notOnConsole] {
			#expect(report(state).overall == .fail)
			#expect(!report(state).canStartSession)
		}
		let unknown = report(.unknown(reason: "probe"))
		#expect(unknown.overall == .warn)
		#expect(unknown.canStartSession)
		#expect(report(.available).overall == .pass)
	}
}
