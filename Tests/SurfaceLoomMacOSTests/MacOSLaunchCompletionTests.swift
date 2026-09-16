import Foundation
import Testing
@testable import SurfaceLoomMacOS

@Suite("macOS launch completion contracts")
struct MacOSLaunchCompletionTests {
	private final class Marker: Error {}

	@Test("A timed-out callback taints without cleaning a profile and may complete late")
	func lateCallbackIsFailClosed() {
		let callback = MacOSLaunchCallbackState<String>()
		var profileCleaned = false
		var ownedApplication: String?

		#expect(throws: Marker.self) {
			try MacOSLaunchCompletionHandler.finish(
				result: callback.result,
				stablyNoLiveApplications: { true },
				bindOwned: { ownedApplication = $0 },
				cleanupProfile: { profileCleaned = true },
				cleanupOwnedApplication: {},
				makeTaint: { _, _ in Marker() }
			)
		}
		#expect(!profileCleaned)
		#expect(ownedApplication == nil)

		callback.complete(application: "late-app", error: nil)
		#expect(callback.result?.application == "late-app")
	}

	@Test("An error carrying an application binds ownership before required cleanup")
	func errorWithApplicationCleansOwnedProcess() {
		let original = Marker()
		var events: [String] = []
		do {
			try MacOSLaunchCompletionHandler.finish(
				result: MacOSLaunchCallbackResult(application: "owned-app", error: original),
				stablyNoLiveApplications: { false },
				bindOwned: { events.append("bind:\($0)") },
				cleanupProfile: { events.append("profile") },
				cleanupOwnedApplication: { events.append("terminate") },
				makeTaint: { _, _ in Marker() }
			)
			Issue.record("Expected the launch failure")
		} catch let error as DesktopAutomationError {
			guard case .launchFailed = error else {
				Issue.record("Expected launchFailed, received \(error)")
				return
			}
		} catch {
			Issue.record("Expected DesktopAutomationError, received \(error)")
		}
		#expect(events == ["bind:owned-app", "terminate"])
	}

	@Test("A callback without identity never cleans while a bundle process is live")
	func missingIdentityWithLiveProcessTaints() {
		var profileCleaned = false
		#expect(throws: Marker.self) {
			try MacOSLaunchCompletionHandler.finish(
				result: MacOSLaunchCallbackResult<String>(application: nil, error: nil),
				stablyNoLiveApplications: { false },
				bindOwned: { _ in Issue.record("Must not bind without an identity") },
				cleanupProfile: { profileCleaned = true },
				cleanupOwnedApplication: {
					Issue.record("Must not terminate an unidentified process")
				},
				makeTaint: { _, _ in Marker() }
			)
		}
		#expect(!profileCleaned)
	}

	@Test("A completed failure cleans only after stable bundle absence")
	func safeFailureWithoutApplicationCleansProfile() {
		var profileCleaned = false
		#expect(throws: DesktopAutomationError.self) {
			try MacOSLaunchCompletionHandler.finish(
				result: MacOSLaunchCallbackResult<String>(application: nil, error: Marker()),
				stablyNoLiveApplications: { true },
				bindOwned: { _ in Issue.record("Must not bind without an identity") },
				cleanupProfile: { profileCleaned = true },
				cleanupOwnedApplication: {},
				makeTaint: { _, _ in Marker() }
			)
		}
		#expect(profileCleaned)
	}
}
