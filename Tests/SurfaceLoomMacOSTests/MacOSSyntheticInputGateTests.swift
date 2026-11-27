import ApplicationServices
import Foundation
import Testing
@testable import SurfaceLoomMacOS

/// Replays scripted session states in order, then repeats the last one.
final class ScriptedSessionProbe: @unchecked Sendable {
	private let lock = NSLock()
	private var states: [MacOSSessionInputState]
	private(set) var reads = 0

	init(_ states: MacOSSessionInputState...) { self.states = states }

	var probe: MacOSSessionInputProbe {
		MacOSSessionInputProbe { self.next() }
	}

	private func next() -> MacOSSessionInputState {
		lock.withLock {
			reads += 1
			return states.count > 1 ? states.removeFirst() : states[0]
		}
	}
}

@Suite("macOS synthetic input session gate")
struct MacOSSyntheticInputGateTests {
	private static let refused: [MacOSSessionInputState] = [
		.screenLocked, .notOnConsole, .unknown(reason: "fake probe"),
	]

	@Test("Refused sessions neither activate nor emit", arguments: refused)
	func refusedSessionDoesNothing(state: MacOSSessionInputState) {
		let session = ScriptedSessionProbe(state)
		var activations = 0
		var emissions = 0
		expectSessionError(state) {
			try MacOSSyntheticInputGate(probe: session.probe).run(
				activate: { activations += 1 },
				emit: { emissions += 1 }
			)
		}
		#expect(activations == 0)
		#expect(emissions == 0)
		#expect(session.reads == 1)
	}

	@Test("An available session activates then emits exactly once")
	func availableSessionProceeds() throws {
		let session = ScriptedSessionProbe(.available)
		var order: [String] = []
		try MacOSSyntheticInputGate(probe: session.probe).run(
			activate: { order.append("activate") },
			emit: { order.append("emit") }
		)
		#expect(order == ["activate", "emit"])
		#expect(session.reads == 2)
	}

	@Test("A lock that lands during activation still emits nothing")
	func lockDuringActivationBlocksEmission() {
		let session = ScriptedSessionProbe(.available, .screenLocked)
		var activations = 0
		var emissions = 0
		expectSessionError(.screenLocked) {
			try MacOSSyntheticInputGate(probe: session.probe).run(
				activate: { activations += 1 },
				emit: { emissions += 1 }
			)
		}
		#expect(activations == 1)
		#expect(emissions == 0)
	}

	@Test("Driver input and attach entry points refuse before touching the app", arguments: refused)
	func driverRefusesBeforeActivation(state: MacOSSessionInputState) {
		let session = ScriptedSessionProbe(state)
		let driver = makeDriver(session.probe)
		#expect(driver.sessionInputState == state)
		expectSessionError(state) { try driver.clickCenter(of: AXUIElementCreateSystemWide()) }
		expectSessionError(state) { try driver.pressShortcut(.escape) }
		expectSessionError(state) { try driver.attachToRunningApplication() }
		// One read for the accessor plus one per entry point: the post-activation
		// re-check was never reached, so no activation and no event posting ran.
		#expect(session.reads == 4)
		#expect(!driver.isRunning)
	}

	@Test("An available session falls through to the existing preconditions")
	func driverAvailableKeepsExistingErrors() {
		let driver = makeDriver(ScriptedSessionProbe(.available).probe)
		expectActionFailed { try driver.clickCenter(of: AXUIElementCreateSystemWide()) }
		expectActionFailed { try driver.pressShortcut(.escape) }
		do {
			try driver.attachToRunningApplication()
			Issue.record("Expected attach to find no running application")
		} catch DesktopAutomationError.runningApplicationNotFound {
		} catch {
			Issue.record("Expected runningApplicationNotFound, received \(error)")
		}
	}

	@Test("The test harness forwards an injected session probe to its driver")
	func harnessForwardsInjectedProbe() {
		let session = ScriptedSessionProbe(.notOnConsole)
		var bodyRan = false
		expectSessionError(.notOnConsole) {
			try MacOSTestHarness.withAttachedApplication(
				configuration: makeConfiguration(),
				sessionInputProbe: session.probe
			) { _ in bodyRan = true }
		}
		#expect(!bodyRan)
		#expect(session.reads == 1)
	}

	private func makeConfiguration() -> MacOSAppConfiguration {
		MacOSAppConfiguration(
			appURL: URL(fileURLWithPath: "/Applications/SessionGate.app"),
			bundleIdentifier: "com.example.surfaceloom.session-gate.\(UUID())",
			displayName: "SessionGate"
		)
	}

	private func makeDriver(_ probe: MacOSSessionInputProbe) -> MacOSApplicationDriver {
		MacOSApplicationDriver(configuration: makeConfiguration(), sessionInputProbe: probe)
	}

	private func expectSessionError(
		_ expected: MacOSSessionInputState,
		_ body: () throws -> Void
	) {
		do {
			try body()
			Issue.record("Expected sessionInputUnavailable(\(expected.code))")
		} catch let DesktopAutomationError.sessionInputUnavailable(state) {
			#expect(state == expected)
		} catch {
			Issue.record("Expected sessionInputUnavailable, received \(error)")
		}
	}

	private func expectActionFailed(_ body: () throws -> Void) {
		do {
			try body()
			Issue.record("Expected actionFailed for an unbound driver")
		} catch DesktopAutomationError.actionFailed {
		} catch {
			Issue.record("Expected actionFailed, received \(error)")
		}
	}
}
