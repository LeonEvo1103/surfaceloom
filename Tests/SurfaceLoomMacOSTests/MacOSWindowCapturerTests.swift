import CoreGraphics
import Foundation
import Testing
@testable import SurfaceLoomMacOS

func makeImage(width: Int = 4, height: Int = 3) -> CGImage {
	let context = CGContext(
		data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
		space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
	)!
	context.setFillColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1)
	context.fill(CGRect(x: 0, y: 0, width: width, height: height))
	return context.makeImage()!
}

/// Records every side effect so tests can prove which steps were (not) reached.
final class FakeCaptureEnvironment {
	var granted = true
	var windows = [makeWindow(11), makeWindow(12)]
	var imageOutcome: MacOSWindowImageOutcome = .image(makeImage())
	var writeError: String?
	var verifiedBytes: Int? = 1234
	var existing = false
	var calls: [String] = []
	var capturedWindowID: CGWindowID?
	var capturedTimeout: TimeInterval?
	var removed: [URL] = []
	let instant = Date(timeIntervalSince1970: 1_800_000_000)

	var dependencies: MacOSWindowCaptureDependencies {
		MacOSWindowCaptureDependencies(
			image: imageDependencies,
			writePNG: { _, _ in self.calls.append("write"); return self.writeError },
			verifiedPNGByteCount: { _ in self.calls.append("verify"); return self.verifiedBytes },
			fileExists: { _ in self.existing },
			removeFile: { self.removed.append($0) },
			now: { self.instant }
		)
	}

	var imageDependencies: MacOSWindowImageDependencies {
		MacOSWindowImageDependencies(
			isScreenCaptureGranted: { self.calls.append("preflight"); return self.granted },
			listWindows: { self.calls.append("list"); return self.windows },
			captureImage: { window, timeout in
				self.calls.append("capture"); self.capturedWindowID = window.windowID
				self.capturedTimeout = timeout; return self.imageOutcome
			}
		)
	}

	func run(pid: pid_t? = 100, timeout: TimeInterval = 2) -> MacOSWindowCaptureResult {
		MacOSWindowCapturer.capture(
			ownerPID: pid, to: URL(fileURLWithPath: "/tmp/out/failure.png"),
			options: MacOSWindowCaptureOptions(timeout: timeout), dependencies: dependencies
		)
	}
}

struct MacOSWindowCapturerTests {
	@Test func capturesFrontmostOwnedWindowWithVerifiedFileFacts() {
		let fake = FakeCaptureEnvironment()
		fake.windows = [makeWindow(3, pid: 999), makeWindow(4, layer: 8), makeWindow(5), makeWindow(6)]
		fake.imageOutcome = .image(makeImage(width: 1600, height: 1200))
		let capture = fake.run().capture
		#expect(capture == MacOSWindowCapture(
			fileURL: URL(fileURLWithPath: "/tmp/out/failure.png"), byteCount: 1234,
			pixelWidth: 1600, pixelHeight: 1200, windowID: 5, ownerPID: 100, capturedAt: fake.instant
		))
		#expect(fake.calls == ["preflight", "list", "capture", "write", "verify"])
	}

	@Test func missingPermissionStopsBeforeAnyWindowOrScreenCaptureCall() {
		let fake = FakeCaptureEnvironment()
		fake.granted = false
		#expect(fake.run() == .permissionNotGranted)
		#expect(fake.calls == ["preflight"])
	}

	@Test func unboundApplicationIsReportedWithoutTouchingPermissionOrCapture() {
		let fake = FakeCaptureEnvironment()
		guard case .noCapturableWindow = fake.run(pid: nil) else { Issue.record("expected noCapturableWindow"); return }
		#expect(fake.calls.isEmpty)
	}

	@Test func onlyOverlaysZeroSizedOrForeignWindowsMeansNoCapturableWindow() {
		let fake = FakeCaptureEnvironment()
		fake.windows = [makeWindow(1, layer: 101), makeWindow(2, size: .zero), makeWindow(3, pid: 4)]
		guard case let .noCapturableWindow(reason) = fake.run() else { Issue.record("expected noCapturableWindow"); return }
		#expect(reason.contains("pid 100"))
		#expect(!fake.calls.contains("capture"))
	}

	@Test func backendFailureTimeoutAndVanishedWindowMapToDistinctResults() {
		let fake = FakeCaptureEnvironment()
		fake.imageOutcome = .failed("stream refused")
		#expect(fake.run() == .failed(reason: "stream refused"))
		fake.imageOutcome = .timedOut
		#expect(fake.run(timeout: 0.5) == .timedOut(after: 0.5))
		fake.imageOutcome = .windowUnavailable("gone")
		#expect(fake.run() == .noCapturableWindow(reason: "gone"))
		#expect(!fake.calls.contains("write"))
	}

	@Test func emptyImageOrUnverifiedFileIsAFailureAndLeavesNoFile() {
		let fake = FakeCaptureEnvironment()
		fake.writeError = "disk full"
		#expect(fake.run() == .failed(reason: "writing PNG failed: disk full"))
		#expect(fake.removed.count == 1)
		fake.writeError = nil
		fake.verifiedBytes = nil
		guard case .failed = fake.run() else { Issue.record("expected failed"); return }
		#expect(fake.removed.count == 2)
		fake.verifiedBytes = 0
		guard case .failed = fake.run() else { Issue.record("expected failed"); return }
		#expect(fake.removed.count == 3)
	}

	@Test func existingDestinationIsNeverOverwritten() {
		let fake = FakeCaptureEnvironment()
		fake.existing = true
		guard case .failed = fake.run() else { Issue.record("expected failed"); return }
		#expect(!fake.calls.contains("capture"))
		#expect(fake.removed.isEmpty)
	}
}
