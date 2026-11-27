import Foundation

/// Session precondition for activation and synthetic (CGEvent) input.
/// The session is checked before activation and again immediately before
/// emission, so a lock that lands during activation still emits nothing.
/// `.unknown` fails closed: input is refused rather than sent blind.
struct MacOSSyntheticInputGate {
	let probe: MacOSSessionInputProbe

	func requireAvailable() throws {
		let state = probe.currentState()
		guard state.permitsSyntheticInput else {
			throw DesktopAutomationError.sessionInputUnavailable(state)
		}
	}

	func run(activate: () throws -> Void, emit: () throws -> Void) throws {
		try requireAvailable()
		try activate()
		try requireAvailable()
		try emit()
	}

	/// The gate composed with opt-in action evidence. An initially unavailable
	/// session is refused before evidence opens, so no frame of a lock screen is
	/// captured and the target is never resolved. Once admitted, evidence wraps
	/// the whole gated run: a lock that lands during activation is traced as a
	/// failed action. Without an installed recorder this is exactly `run`.
	func runRecorded(
		action: String,
		target: @autoclosure () -> String,
		pid: pid_t,
		activate: () throws -> Void,
		emit: () throws -> Void
	) throws {
		try requireAvailable()
		try MacOSActionEvidence.perform(action: action, target: target(), pid: pid) {
			try run(activate: activate, emit: emit)
		}
	}
}

extension MacOSApplicationDriver {
	/// Read-only view of the runner session as seen by this driver's probe.
	public var sessionInputState: MacOSSessionInputState {
		sessionInputProbe.currentState()
	}

	var syntheticInputGate: MacOSSyntheticInputGate {
		MacOSSyntheticInputGate(probe: sessionInputProbe)
	}
}
