import Foundation

extension MacOSAutomationDoctor {
	/// Locked or off-console sessions fail (synthetic input will be refused);
	/// an unprovable session warns, and the driver still refuses input for it.
	static func sessionInputReadiness(_ state: MacOSSessionInputState) -> MacOSDoctorCheck {
		var details = [
			"state": state.code,
			"syntheticInput": state.permitsSyntheticInput ? "allowed" : "refused",
			"source": "CGSessionCopyCurrentDictionary",
		]
		if case let .unknown(reason) = state { details["reason"] = reason }
		return MacOSDoctorCheck(
			id: sessionInputCheck,
			status: status(for: state),
			summary: "Synthetic input readiness: \(state.summary).",
			required: true,
			details: details,
			remediation: remediation(for: state)
		)
	}

	private static func status(for state: MacOSSessionInputState) -> MacOSDoctorStatus {
		switch state {
		case .available: return .pass
		case .screenLocked, .notOnConsole: return .fail
		case .unknown: return .warn
		}
	}

	private static func remediation(for state: MacOSSessionInputState) -> String? {
		switch state {
		case .available:
			return nil
		case .screenLocked:
			return "Unlock the runner user's macOS session (for a dedicated test user, disable the screen saver password and display sleep), then run doctor again."
		case .notOnConsole:
			return "Run the suite in the user session that currently owns the console (log in or fast-user-switch back to it); background or remote-only sessions cannot receive synthetic input."
		case .unknown:
			return "Run from a logged-in GUI session (not a launchd daemon or bare SSH shell) so the window server session can be read, then run doctor again."
		}
	}
}
