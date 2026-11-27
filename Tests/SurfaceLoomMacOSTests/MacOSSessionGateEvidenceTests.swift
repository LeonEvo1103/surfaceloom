import ApplicationServices
import Foundation
import Testing
@testable import SurfaceLoomMacOS

/// The session gate composed with opt-in action evidence. Every test uses a
/// scripted session probe and a fake capture backend: no CGEvent is posted, no
/// application is activated and no screen capture permission is requested.
/// Nested in the serialized evidence suite because both install the single
/// process-wide recorder and must not interleave.
extension MacOSActionEvidenceTests {
	@Suite("macOS session gate with action evidence", .serialized)
	struct SessionGate {
		private static let refused: [MacOSSessionInputState] = [
			.screenLocked, .notOnConsole, .unknown(reason: "fake probe"),
		]

		@Test("A refused session opens no evidence, resolves no target and does nothing", arguments: refused)
		func refusedSessionLeavesNoEvidence(state: MacOSSessionInputState) throws {
			try withRecorder { trace, capture in
				let session = ScriptedSessionProbe(state)
				var steps: [String] = []
				expectSessionError(state) {
					try MacOSSyntheticInputGate(probe: session.probe).runRecorded(
						action: "click", target: resolveTarget(&steps), pid: 42,
						activate: { steps.append("activate") },
						emit: { steps.append("emit") }
					)
				}
				#expect(steps.isEmpty)
				#expect(capture.calls.isEmpty)
				#expect(session.reads == 1)
				let events = try trace.events()
				#expect(events.isEmpty)
			}
		}

		@Test("An admitted action is bracketed by evidence and traced as completed")
		func admittedActionIsBracketed() throws {
			try withRecorder { trace, capture in
				let session = ScriptedSessionProbe(.available)
				var steps: [String] = []
				capture.onCapture = { steps.append("capture") }
				try MacOSSyntheticInputGate(probe: session.probe).runRecorded(
					action: "shortcut", target: "escape", pid: 42,
					activate: { steps.append("activate") },
					emit: { steps.append("emit") }
				)
				#expect(steps == ["capture", "activate", "emit", "capture"])
				#expect(capture.calls == [42, 42])
				let events = try trace.events()
				#expect(events.count == 1)
				#expect(events.first?["action"] == "shortcut")
				#expect(events.first?["result"] == "completed")
			}
		}

		@Test("A lock during activation emits nothing and is traced as a failed action")
		func lockDuringActivationIsTracedAsFailure() throws {
			try withRecorder { trace, capture in
				// Reads: admission, pre-activation re-check, post-activation re-check.
				let session = ScriptedSessionProbe(.available, .available, .screenLocked)
				var steps: [String] = []
				expectSessionError(.screenLocked) {
					try MacOSSyntheticInputGate(probe: session.probe).runRecorded(
						action: "click", target: "AXButton:confirm", pid: 42,
						activate: { steps.append("activate") },
						emit: { steps.append("emit") }
					)
				}
				#expect(steps == ["activate"])
				#expect(capture.calls == [42, 42])
				let events = try trace.events()
				#expect(events.count == 1)
				#expect(events.first?["action"] == "click")
				#expect(events.first?["result"] == "failed")
			}
		}

		@Test("Without an installed recorder the composition behaves exactly like the gate")
		func noRecorderBehavesLikeGate() throws {
			MacOSActionEvidence.clear()
			var steps: [String] = []
			try MacOSSyntheticInputGate(probe: ScriptedSessionProbe(.available).probe).runRecorded(
				action: "click", target: "AXButton", pid: 42,
				activate: { steps.append("activate") },
				emit: { steps.append("emit") }
			)
			#expect(steps == ["activate", "emit"])
			expectSessionError(.screenLocked) {
				try MacOSSyntheticInputGate(probe: ScriptedSessionProbe(.available, .available, .screenLocked).probe)
					.runRecorded(
						action: "click", target: "AXButton", pid: 42,
						activate: { steps.append("activate") },
						emit: { steps.append("emit") }
					)
			}
			#expect(steps == ["activate", "emit", "activate"])
		}

		@Test("Driver click and shortcut refuse a locked session before any capture", arguments: refused)
		func driverRefusalCapturesNothing(state: MacOSSessionInputState) throws {
			try withRecorder { trace, capture in
				let driver = makeDriver(ScriptedSessionProbe(state).probe)
				expectSessionError(state) { try driver.clickCenter(of: AXUIElementCreateSystemWide()) }
				expectSessionError(state) { try driver.pressShortcut(.escape) }
				#expect(capture.calls.isEmpty)
				let events = try trace.events()
				#expect(events.isEmpty)
			}
		}

		@Test("Admitted driver actions keep their original error and are traced as failed")
		func admittedDriverFailureIsTraced() throws {
			try withRecorder { trace, capture in
				let driver = makeDriver(ScriptedSessionProbe(.available).probe)
				expectActionFailed { try driver.clickCenter(of: AXUIElementCreateSystemWide()) }
				expectActionFailed { try driver.pressShortcut(.escape) }
				#expect(capture.calls.count == 4)
				let events = try trace.events()
				#expect(events.map { $0["action"] } == ["click", "shortcut"])
				#expect(events.allSatisfy { $0["result"] == "failed" })
			}
		}

		@Test("AXPress is recorded but never consults the session gate")
		func pressBypassesSessionGate() throws {
			try withRecorder { trace, _ in
				let session = ScriptedSessionProbe(.screenLocked)
				let driver = makeDriver(session.probe)
				// The system-wide element exposes no press action, so this fails in AX
				// itself without touching any application, locked session or not.
				expectActionFailed { try driver.press(AXUIElementCreateSystemWide()) }
				#expect(session.reads == 0)
				let events = try trace.events()
				#expect(events.map { $0["action"] } == ["press"])
				#expect(events.first?["result"] == "failed")
			}
		}

		private func resolveTarget(_ steps: inout [String]) -> String {
			steps.append("target")
			return "AXButton:confirm"
		}

		private func withRecorder(_ body: (RecordedTrace, FakeWindowCapture) throws -> Void) throws {
			let directory = temporaryDirectory()
			defer {
				MacOSActionEvidence.clear()
				try? FileManager.default.removeItem(at: directory)
			}
			let capture = FakeWindowCapture()
			let recorder = MacOSActionEvidence(directory: directory, permission: { true }, capturer: capture)
			MacOSActionEvidence.install(recorder)
			try body(RecordedTrace(recorder: recorder, directory: directory), capture)
		}

		private func temporaryDirectory() -> URL {
			FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		}

		private func makeDriver(_ probe: MacOSSessionInputProbe) -> MacOSApplicationDriver {
			MacOSApplicationDriver(
				configuration: MacOSAppConfiguration(
					appURL: URL(fileURLWithPath: "/Applications/SessionGateEvidence.app"),
					bundleIdentifier: "com.example.surfaceloom.session-evidence.\(UUID())",
					displayName: "SessionGateEvidence"
				),
				sessionInputProbe: probe
			)
		}

		private func expectSessionError(_ expected: MacOSSessionInputState, _ body: () throws -> Void) {
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
				Issue.record("Expected the original actionFailed error")
			} catch DesktopAutomationError.actionFailed {
			} catch {
				Issue.record("Expected actionFailed, received \(error)")
			}
		}
	}
}

/// Reads the trace exactly as the recorder publishes it in `manifest.json`.
private struct RecordedTrace {
	let recorder: MacOSActionEvidence
	let directory: URL

	func events() throws -> [[String: String]] {
		_ = try recorder.finalize(outcome: "failed")
		let data = try Data(contentsOf: directory.appendingPathComponent("manifest.json"))
		let manifest = try #require(JSONSerialization.jsonObject(with: data) as? [String: [[String: String]]])
		return try #require(manifest["events"])
	}
}

private final class FakeWindowCapture: MacOSWindowCapturing {
	var calls: [pid_t] = []
	var onCapture: () -> Void = {}
	func capturePNG(pid: pid_t) throws -> Data {
		calls.append(pid)
		onCapture()
		return Data([137, 80, 78, 71])
	}
}
