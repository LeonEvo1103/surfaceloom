import Foundation

/// An invalidated AX snapshot is indeterminate, never evidence of absence.
enum MacOSStableAbsence {
	static func require(
		name: String, consecutiveObservations: Int, timeout: TimeInterval,
		observe: () throws -> MacOSAXPresence
	) throws {
		let deadline = Date().addingTimeInterval(max(timeout, 0))
		var consecutive = 0
		var lastFailure: Error?
		repeat {
			do {
				switch try observe() {
				case .absent: consecutive += 1
				case .present: consecutive = 0
				}
				lastFailure = nil
				if consecutive >= consecutiveObservations { return }
			} catch {
				guard case DesktopAutomationError.actionFailed(let reason) = error,
					reason == "Accessibility observation failed with code -25202" else { throw error }
				consecutive = 0
				lastFailure = error
			}
			RunLoop.current.run(until: Date().addingTimeInterval(0.05))
		} while Date() < deadline
		if let lastFailure { throw lastFailure }
		throw DesktopAutomationError.actionFailed("Stable absence was not proven for \(name)")
	}
}
