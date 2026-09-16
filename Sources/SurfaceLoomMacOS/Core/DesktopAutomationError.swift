import Foundation

public enum DesktopAutomationError: LocalizedError {
	case appBundleMissing(URL)
	case appAlreadyRunning(String)
	case launchFailed(String)
	case launchTimedOut(String)
	case runningApplicationNotFound(String)
	case runningApplicationAmbiguous(String, count: Int)
	case attachFailed(String)
	case elementNotFound(MacOSAXLocator)
	case elementAmbiguous(MacOSAXLocator, observedMatchCount: Int)
	case invalidMatchPolicy(MacOSAXLocator, reason: String)
	case unsupported(String)
	case actionFailed(String)

	public var errorDescription: String? {
		switch self {
		case let .appBundleMissing(url):
			return "Application bundle not found at \(url.path)"
		case let .appAlreadyRunning(name):
			return "\(name) was already running; the suite never takes over an existing session"
		case let .launchFailed(message):
			return "Application launch failed: \(message)"
		case let .launchTimedOut(expectation):
			return "Application did not satisfy startup expectation: \(expectation)"
		case let .runningApplicationNotFound(bundleIdentifier):
			return "No running application matched bundle identifier \(bundleIdentifier)"
		case let .runningApplicationAmbiguous(bundleIdentifier, count):
			return "Expected one running application for \(bundleIdentifier), found \(count)"
		case let .attachFailed(message):
			return "Application attach failed: \(message)"
		case let .elementNotFound(locator):
			return "No element matched \(locator.name); identifiers=\(locator.identifiers), labels=\(locator.labels), roles=\(locator.roles)"
		case let .elementAmbiguous(locator, observedMatchCount):
			return "Element locator \(locator.name) matched at least \(observedMatchCount) elements; refine it or use an explicit index match policy"
		case let .invalidMatchPolicy(locator, reason):
			return "Invalid match policy for \(locator.name): \(reason)"
		case let .unsupported(reason):
			return "Unsupported automation capability: \(reason)"
		case let .actionFailed(message):
			return message
		}
	}
}
