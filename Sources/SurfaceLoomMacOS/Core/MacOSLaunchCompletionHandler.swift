import Foundation

struct MacOSLaunchCallbackResult<Application> {
	let application: Application?
	let error: Error?
}

final class MacOSLaunchCallbackState<Application>: @unchecked Sendable {
	private let lock = NSLock()
	private var storedResult: MacOSLaunchCallbackResult<Application>?

	var result: MacOSLaunchCallbackResult<Application>? {
		lock.withLock { storedResult }
	}

	func complete(application: Application?, error: Error?) {
		lock.withLock {
			guard storedResult == nil else { return }
			storedResult = MacOSLaunchCallbackResult(application: application, error: error)
		}
	}
}

enum MacOSLaunchCompletionHandler {
	static func finish<Application>(
		result: MacOSLaunchCallbackResult<Application>?,
		stablyNoLiveApplications: () -> Bool,
		bindOwned: (Application) -> Void,
		cleanupProfile: () -> Void,
		cleanupOwnedApplication: () throws -> Void,
		makeTaint: (Error, Error) -> Error
	) throws {
		guard let result else {
			let original = DesktopAutomationError.launchTimedOut("launch callback")
			throw makeTaint(
				original,
				DesktopAutomationError.actionFailed(
					"The asynchronous launch request could not be cancelled or proven stopped"
				)
			)
		}

		let failure = result.error.map {
			DesktopAutomationError.launchFailed($0.localizedDescription)
		}
		if let application = result.application {
			bindOwned(application)
			guard let failure else { return }
			do {
				try cleanupOwnedApplication()
			} catch {
				throw makeTaint(failure, error)
			}
			throw failure
		}

		let original = failure ?? DesktopAutomationError.launchFailed(
			"NSWorkspace returned no application"
		)
		guard stablyNoLiveApplications() else {
			throw makeTaint(
				original,
				DesktopAutomationError.actionFailed(
					"A bundle process exists without a launch callback application identity"
				)
			)
		}
		cleanupProfile()
		throw original
	}
}
