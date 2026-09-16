import Foundation
import Testing
@testable import SurfaceLoomMacOS

@Suite("macOS UI-state recovery contracts")
struct UIStateRecoveryContractTests {
	private final class Marker: Error {}

	@Test("Recovered failures preserve the original error and do not taint")
	func recoveredFailurePreservesOriginal() {
		let barrier = MacOSUIStateTaintBarrier()
		let original = Marker()
		var recoveryCalls = 0
		do {
			_ = try MacOSUIStateRecovery.run(
				operationKey: "dialog.roundtrip",
				barrier: barrier,
				body: { throw original },
				recover: { recoveryCalls += 1 },
				proveBaseline: {}
			) as Void
			Issue.record("Expected the original failure")
		} catch {
			#expect(error as AnyObject === original)
		}
		#expect(recoveryCalls == 1)
		#expect(barrier.canBeginOperation)
	}

	@Test("Cleanup failure trips a first-cause barrier")
	func cleanupFailureTripsBarrier() {
		let barrier = MacOSUIStateTaintBarrier()
		let original = Marker()
		let cleanup = Marker()
		var bodyCalls = 0
		do {
			_ = try MacOSUIStateRecovery.run(
				operationKey: "dialog.roundtrip",
				barrier: barrier,
				body: { bodyCalls += 1; throw original },
				recover: { throw cleanup },
				proveBaseline: {}
			) as Void
			Issue.record("Expected a tainted-state error")
		} catch let taint as MacOSUIStateTaintedError {
			#expect(taint.operationKey == "dialog.roundtrip")
			#expect(taint.originalFailure as AnyObject === original)
			#expect(taint.cleanupFailure as AnyObject === cleanup)
			#expect(!taint.localizedDescription.contains("Marker"))
		} catch {
			Issue.record("Expected MacOSUIStateTaintedError, received \(error)")
		}
		#expect(!barrier.canBeginOperation)

		do {
			_ = try MacOSUIStateRecovery.run(
				operationKey: "dialog.later",
				barrier: barrier,
				body: { bodyCalls += 1 },
				recover: {},
				proveBaseline: {}
			)
			Issue.record("Expected the taint barrier to block later work")
		} catch is MacOSUIStateTaintedError {
			#expect(bodyCalls == 1)
		} catch {
			Issue.record("Expected the first taint, received \(error)")
		}
	}

	@Test("Success still proves baseline and an indeterminate probe taints")
	func successRequiresBaselineProof() {
		let barrier = MacOSUIStateTaintBarrier()
		var recoveryCalls = 0
		var proofCalls = 0
		do {
			_ = try MacOSUIStateRecovery.run(
				operationKey: "dialog.success",
				barrier: barrier,
				body: { "result" },
				recover: { recoveryCalls += 1 },
				proveBaseline: {
					proofCalls += 1
					throw Marker()
				}
			)
			Issue.record("Expected an unprovable baseline to taint")
		} catch is MacOSUIStateTaintedError {
			#expect(recoveryCalls == 1)
			#expect(proofCalls == 2)
			#expect(!barrier.canBeginOperation)
		} catch {
			Issue.record("Expected MacOSUIStateTaintedError, received \(error)")
		}
	}

	@Test("Required launch cleanup preserves failure or taints later sessions")
	func requiredLaunchCleanupIsFailClosed() throws {
		let cleanConfiguration = configuration(suffix: "clean")
		let original = Marker()
		do {
			try MacOSUIStateRecovery.failAfterRequiredCleanup(
				configuration: cleanConfiguration,
				operationKey: "macos.launch.window-timeout-cleanup",
				originalFailure: original,
				cleanup: {}
			)
		} catch {
			#expect(error as AnyObject === original)
		}
		try MacOSUIStateRecovery.requireProcessStateClean(for: cleanConfiguration)

		let taintedConfiguration = configuration(suffix: "tainted")
		let cleanup = Marker()
		do {
			try MacOSUIStateRecovery.failAfterRequiredCleanup(
				configuration: taintedConfiguration,
				operationKey: "macos.launch.window-timeout-cleanup",
				originalFailure: original
			) {
				throw cleanup
			}
		} catch let error as MacOSUIStateTaintedError {
			#expect(error.originalFailure as AnyObject === original)
			#expect(error.cleanupFailure as AnyObject === cleanup)
		} catch {
			Issue.record("Expected a tainted launch failure, received \(error)")
		}
		#expect(throws: MacOSUIStateTaintedError.self) {
			try MacOSUIStateRecovery.requireProcessStateClean(for: taintedConfiguration)
		}
	}

	private func configuration(suffix: String) -> MacOSAppConfiguration {
		MacOSAppConfiguration(
			appURL: URL(
				fileURLWithPath: "/Applications/Contract-\(suffix)-\(UUID()).app"
			),
			bundleIdentifier: "com.example.surfaceloom.\(suffix).\(UUID())",
			displayName: "Contract"
		)
	}
}
