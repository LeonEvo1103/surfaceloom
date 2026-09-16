enum MacOSApplicationOwnership: Sendable, Equatable {
	case none
	case owned
	case attached

	var permitsTermination: Bool { self == .owned }
}

struct MacOSApplicationReference<Application> {
	private(set) var application: Application?
	private(set) var ownership: MacOSApplicationOwnership = .none

	mutating func bind(
		_ application: Application,
		ownership: MacOSApplicationOwnership
	) {
		precondition(ownership != .none, "A bound application must have ownership semantics")
		self.application = application
		self.ownership = ownership
	}

	mutating func detach() {
		guard ownership == .attached else { return }
		application = nil
		ownership = .none
	}

	mutating func releaseOwnedApplication() {
		guard ownership == .owned else { return }
		application = nil
		ownership = .none
	}
}

enum MacOSRunningApplicationResolver {
	static func exactlyOne<Application>(
		_ applications: [Application],
		bundleIdentifier: String
	) throws -> Application {
		switch applications.count {
		case 0:
			throw DesktopAutomationError.runningApplicationNotFound(bundleIdentifier)
		case 1:
			return applications[0]
		default:
			throw DesktopAutomationError.runningApplicationAmbiguous(
				bundleIdentifier,
				count: applications.count
			)
		}
	}
}
