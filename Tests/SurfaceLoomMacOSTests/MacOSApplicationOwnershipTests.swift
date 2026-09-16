import Foundation
import Testing
@testable import SurfaceLoomMacOS

@Suite("macOS application ownership contracts")
struct MacOSApplicationOwnershipTests {
	@Test("Attach requires exactly one running application")
	func exactRunningApplicationSelection() throws {
		let selected = try MacOSRunningApplicationResolver.exactlyOne(
			["only"],
			bundleIdentifier: "com.example.sample"
		)
		#expect(selected == "only")

		do {
			_ = try MacOSRunningApplicationResolver.exactlyOne(
				[String](),
				bundleIdentifier: "com.example.missing"
			)
			Issue.record("Expected an empty running-app set to fail")
		} catch let error as DesktopAutomationError {
			guard case let .runningApplicationNotFound(bundleIdentifier) = error else {
				Issue.record("Expected runningApplicationNotFound, received \(error)")
				return
			}
			#expect(bundleIdentifier == "com.example.missing")
		}

		do {
			_ = try MacOSRunningApplicationResolver.exactlyOne(
				["first", "second"],
				bundleIdentifier: "com.example.ambiguous"
			)
			Issue.record("Expected multiple running apps to fail")
		} catch let error as DesktopAutomationError {
			guard case let .runningApplicationAmbiguous(bundleIdentifier, count) = error else {
				Issue.record("Expected runningApplicationAmbiguous, received \(error)")
				return
			}
			#expect(bundleIdentifier == "com.example.ambiguous")
			#expect(count == 2)
		}
	}

	@Test("Detach clears only non-owning attached references")
	func detachOwnershipContract() {
		var attached = MacOSApplicationReference<String>()
		attached.bind("user-process", ownership: .attached)
		#expect(!attached.ownership.permitsTermination)
		attached.detach()
		#expect(attached.application == nil)
		#expect(attached.ownership == .none)

		var owned = MacOSApplicationReference<String>()
		owned.bind("test-process", ownership: .owned)
		owned.detach()
		#expect(owned.application == "test-process")
		#expect(owned.ownership == .owned)
		#expect(owned.ownership.permitsTermination)
		owned.releaseOwnedApplication()
		#expect(owned.application == nil)
		#expect(owned.ownership == .none)
	}

	@Test("Missing app launch cleans an isolated profile")
	func missingAppCleansLaunchProfile() throws {
		let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
			"surfaceloom-missing-app-\(UUID().uuidString)",
			isDirectory: true
		)
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		defer { try? FileManager.default.removeItem(at: directory) }

		let configuration = MacOSAppConfiguration(
			appURL: directory.appendingPathComponent("Missing.app"),
			bundleIdentifier: "com.example.missing",
			displayName: "Missing",
			launchProfile: MacOSLaunchProfile(cleanupDirectories: [directory])
		)
		let driver = MacOSApplicationDriver(configuration: configuration)

		#expect(throws: DesktopAutomationError.self) {
			try driver.launch()
		}
		#expect(!FileManager.default.fileExists(atPath: directory.path))
	}
}
