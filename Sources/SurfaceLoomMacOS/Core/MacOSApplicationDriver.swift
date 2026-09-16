import AppKit
import Darwin
import Foundation

public final class MacOSApplicationDriver {
	public let configuration: MacOSAppConfiguration

	private var reference = MacOSApplicationReference<NSRunningApplication>()
	var application: NSRunningApplication? { reference.application }

	public init(configuration: MacOSAppConfiguration) {
		self.configuration = configuration
	}

	public func launch() throws {
		try MacOSUIStateRecovery.requireProcessStateClean(for: configuration)
		guard FileManager.default.fileExists(atPath: configuration.appURL.path) else {
			cleanupLaunchProfile()
			throw DesktopAutomationError.appBundleMissing(configuration.appURL)
		}
		guard liveBundleApplications().isEmpty else {
			cleanupLaunchProfile()
			throw DesktopAutomationError.appAlreadyRunning(configuration.displayName)
		}

		let openConfiguration = NSWorkspace.OpenConfiguration()
		openConfiguration.activates = true
		openConfiguration.addsToRecentItems = false
		if !configuration.launchProfile.environment.isEmpty {
			openConfiguration.environment = ProcessInfo.processInfo.environment
				.merging(configuration.launchProfile.environment) { _, productValue in productValue }
		}

		let callback = MacOSLaunchCallbackState<NSRunningApplication>()
		NSWorkspace.shared.openApplication(
			at: configuration.appURL,
			configuration: openConfiguration
		) { app, error in
			callback.complete(application: app, error: error)
		}

		_ = wait(until: { callback.result != nil }, timeout: configuration.launchTimeout)
		try MacOSLaunchCompletionHandler.finish(
			result: callback.result,
			stablyNoLiveApplications: { self.bundleIsStablyAbsent() },
			bindOwned: { self.reference.bind($0, ownership: .owned) },
			cleanupProfile: { self.cleanupLaunchProfile() },
			cleanupOwnedApplication: { try self.terminateAndRequireStopped() },
			makeTaint: { original, cleanup in
				MacOSUIStateRecovery.markTainted(
					configuration: self.configuration,
					operationKey: "macos.launch.callback-resolution",
					originalFailure: original,
					cleanupFailure: cleanup
				)
			}
		)
		if configuration.startupExpectation == .onScreenWindow,
			!waitForOnScreenWindow(timeout: configuration.launchTimeout) {
			let failure = DesktopAutomationError.launchTimedOut("an on-screen window")
			try MacOSUIStateRecovery.failAfterRequiredCleanup(
				configuration: configuration,
				operationKey: "macos.launch.window-timeout-cleanup",
				originalFailure: failure
			) {
				try terminateAndRequireStopped()
			}
		}
	}

	public func attachToRunningApplication() throws {
		try MacOSUIStateRecovery.requireProcessStateClean(for: configuration)
		guard reference.ownership == .none else {
			throw DesktopAutomationError.attachFailed("the driver already has an application")
		}
		let runningApplication = try MacOSRunningApplicationResolver.exactlyOne(
			liveBundleApplications(),
			bundleIdentifier: configuration.bundleIdentifier
		)
		reference.bind(runningApplication, ownership: .attached)

		let activationTimeout = min(max(configuration.launchTimeout, 0), 8)
		let activationDeadline = Date().addingTimeInterval(activationTimeout)
		var becameActive = runningApplication.isActive
		repeat {
			_ = runningApplication.activate()
			let remaining = max(activationDeadline.timeIntervalSinceNow, 0)
			becameActive = wait(
				until: { runningApplication.isActive },
				timeout: min(remaining, 1)
			)
		} while !becameActive && Date() < activationDeadline

		guard becameActive else {
			detach()
			throw DesktopAutomationError.attachFailed(
				"\(configuration.displayName) did not become active"
			)
		}
		guard waitForOnScreenWindow(timeout: configuration.launchTimeout) else {
			detach()
			throw DesktopAutomationError.attachFailed(
				"\(configuration.displayName) did not expose an on-screen window"
			)
		}
	}

	public func detach() {
		reference.detach()
	}

	public func terminate() {
		try? terminateAndRequireStopped()
	}

	public func terminateAndRequireStopped() throws {
		guard reference.ownership.permitsTermination else { return }
		guard let application else { return }
		if !isProcessAlive(application.processIdentifier) {
			reference.releaseOwnedApplication()
			cleanupLaunchProfile()
			return
		}

		_ = application.terminate()
		_ = wait(until: { !self.isProcessAlive(application.processIdentifier) }, timeout: 10)
		if isProcessAlive(application.processIdentifier) {
			_ = application.forceTerminate()
			_ = wait(until: { !self.isProcessAlive(application.processIdentifier) }, timeout: 5)
		}
		guard !isProcessAlive(application.processIdentifier) else {
			throw DesktopAutomationError.actionFailed(
				"The owned application remained alive after graceful and forced termination"
			)
		}
		reference.releaseOwnedApplication()
		cleanupLaunchProfile()
	}

	public var isRunning: Bool {
		guard let application else { return false }
		return isProcessAlive(application.processIdentifier)
	}

	public var onScreenWindowCount: Int {
		guard let application else { return 0 }
		guard let rawWindows = CGWindowListCopyWindowInfo(
			.optionOnScreenOnly,
			kCGNullWindowID
		) as? [[String: Any]] else {
			return 0
		}
		return rawWindows.filter { window in
			let ownerPID = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
			let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue
			return ownerPID == application.processIdentifier && layer == 0
		}.count
	}

	@discardableResult
	public func waitForOnScreenWindow(timeout: TimeInterval? = nil) -> Bool {
		wait(
			until: { self.onScreenWindowCount > 0 },
			timeout: timeout ?? configuration.launchTimeout
		)
	}

	@discardableResult
	public func waitForNoOnScreenWindows(timeout: TimeInterval = 8) -> Bool {
		wait(until: { self.onScreenWindowCount == 0 }, timeout: timeout)
	}

	@discardableResult
	public func waitForTermination(timeout: TimeInterval = 8) -> Bool {
		guard let application else { return true }
		return wait(
			until: { !self.isProcessAlive(application.processIdentifier) },
			timeout: timeout
		)
	}

	public func reopen() throws {
		let openConfiguration = NSWorkspace.OpenConfiguration()
		openConfiguration.activates = true
		openConfiguration.addsToRecentItems = false
		NSWorkspace.shared.openApplication(
			at: configuration.appURL,
			configuration: openConfiguration
		) { _, _ in }
		guard waitForOnScreenWindow(timeout: 8) else {
			throw DesktopAutomationError.actionFailed(
				"Reopening \(configuration.displayName) did not restore a window"
			)
		}
	}

	func wait(until predicate: () -> Bool, timeout: TimeInterval) -> Bool {
		let deadline = Date().addingTimeInterval(max(timeout, 0))
		repeat {
			if predicate() { return true }
			RunLoop.current.run(until: Date().addingTimeInterval(0.05))
		} while Date() < deadline
		return predicate()
	}

	func isProcessAlive(_ processIdentifier: pid_t) -> Bool {
		if kill(processIdentifier, 0) == 0 { return true }
		return errno == EPERM
	}

	private func liveBundleApplications() -> [NSRunningApplication] {
		NSRunningApplication.runningApplications(
			withBundleIdentifier: configuration.bundleIdentifier
		).filter { isProcessAlive($0.processIdentifier) }
	}

	private func bundleIsStablyAbsent() -> Bool {
		let deadline = Date().addingTimeInterval(0.5)
		repeat {
			guard liveBundleApplications().isEmpty else { return false }
			RunLoop.current.run(until: Date().addingTimeInterval(0.05))
		} while Date() < deadline
		return liveBundleApplications().isEmpty
	}

	private func cleanupLaunchProfile() {
		for directory in configuration.launchProfile.cleanupDirectories {
			try? FileManager.default.removeItem(at: directory)
		}
	}
}
