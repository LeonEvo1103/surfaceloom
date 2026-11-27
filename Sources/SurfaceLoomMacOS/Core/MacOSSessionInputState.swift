import CoreGraphics
import Foundation

/// Whether the window server session of the runner can receive synthetic input.
/// Only `.available` permits activation or CGEvent delivery; anything the probe
/// cannot prove is `.unknown` and is treated as "not available" by the driver.
public enum MacOSSessionInputState: Equatable, Hashable, Sendable {
	case available
	case screenLocked
	case notOnConsole
	case unknown(reason: String)

	/// Stable machine-readable code for reports and doctor details.
	public var code: String {
		switch self {
		case .available: return "available"
		case .screenLocked: return "screenLocked"
		case .notOnConsole: return "notOnConsole"
		case .unknown: return "unknown"
		}
	}

	public var permitsSyntheticInput: Bool { self == .available }

	public var summary: String {
		switch self {
		case .available:
			return "the runner session is on the console and unlocked"
		case .screenLocked:
			return "the runner session screen is locked"
		case .notOnConsole:
			return "the runner session does not own the console"
		case let .unknown(reason):
			return "the runner session state could not be proven (\(reason))"
		}
	}

	static let onConsoleKey = kCGSessionOnConsoleKey as String
	static let loginDoneKey = kCGSessionLoginDoneKey as String
	/// Private but long-standing window server key. It is published only while
	/// the screen is locked; an unlocked console session omits it entirely.
	static let screenLockedKey = "CGSSessionScreenIsLocked"

	/// Pure classification of a `CGSessionCopyCurrentDictionary` result.
	/// A missing dictionary, a missing/non-boolean console flag, or an unfinished
	/// login is `.unknown`; only the lock key may be absent, because its absence
	/// is how the window server represents an unlocked session.
	static func classify(sessionDictionary session: [String: Any]?) -> MacOSSessionInputState {
		guard let session else {
			return .unknown(reason: "no window server session dictionary")
		}
		guard let onConsole = strictBoolean(session[onConsoleKey]) else {
			return .unknown(reason: "\(onConsoleKey) missing or not boolean")
		}
		guard onConsole else { return .notOnConsole }
		guard let loginDone = strictBoolean(session[loginDoneKey]) else {
			return .unknown(reason: "\(loginDoneKey) missing or not boolean")
		}
		guard loginDone else {
			return .unknown(reason: "console login has not completed")
		}
		guard let rawLocked = session[screenLockedKey] else { return .available }
		guard let locked = strictBoolean(rawLocked) else {
			return .unknown(reason: "\(screenLockedKey) is not boolean")
		}
		return locked ? .screenLocked : .available
	}

	private static func strictBoolean(_ value: Any?) -> Bool? {
		guard let number = value as? NSNumber else { return nil }
		switch number.intValue {
		case 0: return false
		case 1: return true
		default: return nil
		}
	}
}

/// Injectable, read-only session probe. `.live` reads the real window server
/// session; tests and adapters can inject a deterministic state source.
public struct MacOSSessionInputProbe: Sendable {
	private let read: @Sendable () -> MacOSSessionInputState

	public init(_ read: @escaping @Sendable () -> MacOSSessionInputState) {
		self.read = read
	}

	public func currentState() -> MacOSSessionInputState { read() }

	public static let live = MacOSSessionInputProbe {
		MacOSSessionInputState.classify(
			sessionDictionary: CGSessionCopyCurrentDictionary() as? [String: Any]
		)
	}
}
