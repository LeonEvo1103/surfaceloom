import ApplicationServices
import Foundation
import Testing
@testable import SurfaceLoomMacOS

@Suite("SurfaceLoom macOS contracts")
struct FrameworkContractTests {
	private let defaults = MacOSAppConfiguration(
		appURL: URL(fileURLWithPath: "/Applications/Sample.app"),
		bundleIdentifier: "com.example.sample",
		displayName: "Sample"
	)

	@Test("Environment parsing is product neutral")
	func environmentParsing() {
		let configuration = MacOSAppConfiguration.fromEnvironment(
			defaults: defaults,
			environment: [
				"DESKTOP_TEST_APP_PATH": "/tmp/Other.app",
				"DESKTOP_TEST_BUNDLE_ID": "com.example.other",
				"DESKTOP_TEST_APP_NAME": "Other",
				"DESKTOP_TEST_TIMEOUT": "42",
				"DESKTOP_TEST_RUN": "1",
			]
		)

		#expect(configuration.appURL.path == "/tmp/Other.app")
		#expect(configuration.bundleIdentifier == "com.example.other")
		#expect(configuration.displayName == "Other")
		#expect(configuration.launchTimeout == 42)
		#expect(configuration.runLiveUI)
	}

	@Test("Launch profile injection preserves application identity")
	func launchProfileInjection() {
		let profile = MacOSLaunchProfile(environment: ["TEST_PROFILE": "/tmp/profile"])
		let configured = defaults.withLaunchProfile(profile)

		#expect(configured.appURL == defaults.appURL)
		#expect(configured.bundleIdentifier == defaults.bundleIdentifier)
		#expect(configured.displayName == defaults.displayName)
		#expect(configured.launchProfile.environment["TEST_PROFILE"] == "/tmp/profile")
	}

	@Test("AX locator prioritizes identifiers but keeps semantic fallbacks")
	func locatorContract() {
		let locator = MacOSAXLocator(
			"Settings button",
			identifiers: ["settings.open"],
			labels: ["Settings", "设置"],
			roles: [MacOSAXRole.button],
			scope: .application
		)

		#expect(locator.name == "Settings button")
		#expect(locator.identifiers == ["settings.open"])
		#expect(locator.labels == ["Settings", "设置"])
		#expect(locator.roles == [MacOSAXRole.button])
		#expect(locator.timeout == 8)
		#expect(locator.matchPolicy == .strict)
	}

	@Test("Strict AX matching rejects ambiguous results")
	func strictMatchingRejectsAmbiguity() {
		let locator = MacOSAXLocator("Duplicate button")

		do {
			_ = try MacOSAXMatchResolver.resolve(["first", "second"], for: locator)
			Issue.record("Expected strict matching to reject multiple results")
		} catch let error as DesktopAutomationError {
			guard case let .elementAmbiguous(reportedLocator, observedMatchCount) = error else {
				Issue.record("Expected elementAmbiguous, received \(error)")
				return
			}
			#expect(reportedLocator.name == locator.name)
			#expect(observedMatchCount == 2)
		} catch {
			Issue.record("Expected DesktopAutomationError, received \(error)")
		}
		#expect(MacOSAXMatchResolver.lookupLimit(for: locator.matchPolicy) == 2)
	}

	@Test("Focus primitive rejects an element without a focus contract")
	func focusRejectsUnsupportedElement() {
		let driver = MacOSApplicationDriver(configuration: defaults)

		do {
			try driver.focus(AXUIElementCreateSystemWide())
			Issue.record("Expected the system-wide element to reject AX focus")
		} catch let error as DesktopAutomationError {
			guard case .actionFailed = error else {
				Issue.record("Expected actionFailed, received \(error)")
				return
			}
		} catch {
			Issue.record("Expected DesktopAutomationError, received \(error)")
		}
	}

	@Test("Center-click primitive requires a running application")
	func centerClickRequiresRunningApplication() {
		let driver = MacOSApplicationDriver(configuration: defaults)

		do {
			try driver.clickCenter(of: AXUIElementCreateSystemWide())
			Issue.record("Expected center click to reject an unbound driver")
		} catch let error as DesktopAutomationError {
			guard case .actionFailed = error else {
				Issue.record("Expected actionFailed, received \(error)")
				return
			}
		} catch {
			Issue.record("Expected DesktopAutomationError, received \(error)")
		}
	}

	@Test("AX relationship and web-state reads fail safely without an application tree")
	func relationshipReadsFailSafely() {
		let driver = MacOSApplicationDriver(configuration: defaults)
		let systemWide = AXUIElementCreateSystemWide()
		let impossible = MacOSAXLocator(
			"Impossible scoped element",
			labels: ["surfaceloom-impossible-scoped-element-7c6c4e41"],
			roles: [MacOSAXRole.button]
		)

		#expect(driver.ariaCurrentValue(of: systemWide) == nil)
		#expect(driver.enabledValue(of: systemWide) == nil)
		#expect(!driver.isModal(systemWide))
		#expect(driver.subroleValue(of: systemWide) == nil)
		#expect(driver.parent(of: systemWide) == nil)
		#expect(driver.findElements(impossible, within: systemWide).isEmpty)
		#expect(MacOSAXRole.group == "AXGroup")
		#expect(MacOSAXRole.popover == "AXPopover")
		#expect(MacOSAXRole.sheet == "AXSheet")
	}

	@Test("Indexed AX matching selects the requested result")
	func indexedMatchingSelectsRequestedResult() throws {
		let locator = MacOSAXLocator(
			"Second row",
			matchPolicy: .index(1)
		)

		let result = try MacOSAXMatchResolver.resolve(
			["first", "second", "third"],
			for: locator
		)

		#expect(result == "second")
		#expect(MacOSAXMatchResolver.lookupLimit(for: locator.matchPolicy) == 2)
	}

	@Test("AX identifiers take priority over label fallback")
	func identifierTierTakesPriority() {
		struct Candidate {
			let id: String
			let labels: Set<String>
		}
		let candidates = [
			Candidate(id: "settings.open", labels: []),
			Candidate(id: "other", labels: ["settings"]),
		]

		let identifierMatch = MacOSAXMatchResolver.prioritizedMatches(
			candidates,
			identifiers: ["settings.open"],
			labels: ["settings"],
			identifierOf: \.id,
			labelsOf: \.labels
		)
		#expect(identifierMatch.map(\.id) == ["settings.open"])

		let fallbackMatch = MacOSAXMatchResolver.prioritizedMatches(
			candidates,
			identifiers: ["missing"],
			labels: ["settings"],
			identifierOf: \.id,
			labelsOf: \.labels
		)
		#expect(fallbackMatch.map(\.id) == ["other"])
	}

	@Test("Background applications can opt out of a window startup expectation")
	func backgroundStartupExpectation() {
		let configuration = MacOSAppConfiguration(
			appURL: defaults.appURL,
			bundleIdentifier: defaults.bundleIdentifier,
			displayName: defaults.displayName,
			startupExpectation: .process
		)
		#expect(configuration.startupExpectation == .process)
	}
}
