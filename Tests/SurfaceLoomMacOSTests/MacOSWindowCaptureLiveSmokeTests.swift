import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import SurfaceLoomMacOS

/// Opt-in live smoke. Every test here is skipped unless SURFACELOOM_MACOS_CAPTURE_LIVE=1.
///
/// SURFACELOOM_MACOS_CAPTURE_APP_PATH: required; an app this test may launch and own (e.g. the
/// built product-neutral fixture). It must not already be running; the driver refuses to take over.
/// SURFACELOOM_MACOS_CAPTURE_BUNDLE_ID: defaults to the fixture's bundle identifier.
/// SURFACELOOM_MACOS_CAPTURE_OUTPUT: optional directory that keeps the PNG for inspection.
///
/// Nothing here requests Screen Recording; grant it manually to the runner before opting in.
struct MacOSWindowCaptureLiveSmokeTests {
	static let environment = ProcessInfo.processInfo.environment
	static let liveRequested = environment["SURFACELOOM_MACOS_CAPTURE_LIVE"] == "1"

	/// Runs only when live is requested AND the preflight says "not granted". A pass means exactly
	/// one thing: the live dependency set returns `.permissionNotGranted` before reaching
	/// ScreenCaptureKit (the injected listing/capture steps are tripwires that must stay untouched).
	/// It is not evidence that capture works.
	@Test(.enabled(if: liveRequested && !MacOSScreenCapturePermission.isGranted))
	func unauthorizedProcessGetsPermissionNotGrantedWithoutTouchingScreenCaptureKit() {
		var dependencies = MacOSWindowCaptureDependencies.live
		var touched: [String] = []
		dependencies.image.listWindows = { touched.append("list"); return [] }
		dependencies.image.captureImage = { _, _ in touched.append("capture"); return .failed("tripwire") }
		let result = MacOSWindowCapturer.capture(
			ownerPID: ProcessInfo.processInfo.processIdentifier,
			to: FileManager.default.temporaryDirectory.appendingPathComponent("unused-\(UUID()).png"),
			options: MacOSWindowCaptureOptions(),
			dependencies: dependencies
		)
		#expect(result == .permissionNotGranted)
		#expect(touched.isEmpty)
	}

	/// The real capture. With live requested it never passes vacuously: missing permission or a
	/// missing target app is a failure with an actionable reason.
	@Test(.enabled(if: liveRequested))
	func capturesOnlyTheOwnedFixtureWindow() throws {
		try #require(
			MacOSScreenCapturePermission.isGranted,
			"""
			Live capture NOT verified: the process running the tests has no Screen Recording permission. \
			Grant it manually (System Settings > Privacy & Security > Screen Recording) to the hosting \
			terminal/runner, then rerun. This test never requests the permission itself.
			"""
		)
		let appPath = try #require(
			Self.environment["SURFACELOOM_MACOS_CAPTURE_APP_PATH"],
			"Live capture NOT verified: set SURFACELOOM_MACOS_CAPTURE_APP_PATH to an app this test may launch and own."
		)
		let configuration = MacOSAppConfiguration(
			appURL: URL(fileURLWithPath: appPath).standardizedFileURL,
			bundleIdentifier: Self.environment["SURFACELOOM_MACOS_CAPTURE_BUNDLE_ID"]
				?? "dev.surfaceloom.fixture.macos",
			displayName: "capture smoke target",
			launchTimeout: 20,
			runLiveUI: true
		)
		let driver = MacOSApplicationDriver(configuration: configuration)
		try driver.launch()
		defer { try? driver.terminateAndRequireStopped() }

		let directory = Self.environment["SURFACELOOM_MACOS_CAPTURE_OUTPUT"].map { URL(fileURLWithPath: $0) }
			?? FileManager.default.temporaryDirectory.appendingPathComponent("surfaceloom-capture-live")
		let destination = directory.appendingPathComponent("window-\(UUID().uuidString).png")
		let result = driver.captureBoundWindow(to: destination, options: MacOSWindowCaptureOptions(timeout: 10))
		let capture = try #require(result.capture, "capture result: \(result)")
		let source = try #require(CGImageSourceCreateWithURL(capture.fileURL as CFURL, nil))
		let decoded = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
		#expect(decoded.width == capture.pixelWidth && decoded.height == capture.pixelHeight)
		#expect(capture.byteCount > 0)
		print("[surfaceloom-capture-live] captured \(capture.fileURL.path) bytes=\(capture.byteCount) "
			+ "pixels=\(capture.pixelWidth)x\(capture.pixelHeight) window=\(capture.windowID)")
	}
}
