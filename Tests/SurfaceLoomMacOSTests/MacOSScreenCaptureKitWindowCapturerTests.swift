import CoreGraphics
import Foundation
import Testing
@testable import SurfaceLoomMacOS

struct MacOSScreenCaptureKitWindowCapturerTests {
	func makeCapturer(
		_ fake: FakeCaptureEnvironment,
		timeout: TimeInterval = 2,
		encodePNG: @escaping (CGImage) -> Data? = MacOSPNGEncoding.data(from:)
	) -> MacOSScreenCaptureKitWindowCapturer {
		MacOSScreenCaptureKitWindowCapturer(
			options: MacOSWindowCaptureOptions(timeout: timeout),
			dependencies: fake.imageDependencies,
			encodePNG: encodePNG
		)
	}

	func thrownError(_ body: () throws -> Data) -> MacOSWindowCaptureError? {
		do {
			_ = try body()
			return nil
		} catch let error as MacOSWindowCaptureError {
			return error
		} catch {
			Issue.record("unexpected error type: \(error)")
			return nil
		}
	}

	@Test func returnsPNGDataOfTheFrontmostOwnedWindow() throws {
		let fake = FakeCaptureEnvironment()
		fake.windows = [makeWindow(3, pid: 999), makeWindow(4, layer: 8), makeWindow(5), makeWindow(6)]
		fake.imageOutcome = .image(makeImage(width: 7, height: 5))
		let data = try makeCapturer(fake, timeout: 1.5).capturePNG(pid: 100)
		#expect(Array(data.prefix(8)) == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
		#expect(fake.capturedWindowID == 5)
		#expect(fake.capturedTimeout == 1.5)
		#expect(fake.calls == ["preflight", "list", "capture"])
	}

	@Test func missingPermissionThrowsBeforeListingOrCapturing() {
		let fake = FakeCaptureEnvironment()
		fake.granted = false
		#expect(thrownError { try makeCapturer(fake).capturePNG(pid: 100) } == .permissionNotGranted)
		#expect(fake.calls == ["preflight"])
	}

	@Test func noCapturableWindowThrowsWithoutCapturing() {
		let fake = FakeCaptureEnvironment()
		fake.windows = [makeWindow(1, layer: 101), makeWindow(2, size: .zero), makeWindow(3, pid: 4)]
		guard case let .noCapturableWindow(reason) = thrownError({ try makeCapturer(fake).capturePNG(pid: 100) }) else {
			Issue.record("expected noCapturableWindow"); return
		}
		#expect(reason.contains("pid 100"))
		#expect(!fake.calls.contains("capture"))
	}

	@Test func backendFailureAndVanishedWindowThrowDistinctErrors() {
		let fake = FakeCaptureEnvironment()
		fake.imageOutcome = .failed("stream refused")
		#expect(thrownError { try makeCapturer(fake).capturePNG(pid: 100) } == .failed(reason: "stream refused"))
		fake.imageOutcome = .windowUnavailable("gone")
		#expect(thrownError { try makeCapturer(fake).capturePNG(pid: 100) } == .noCapturableWindow(reason: "gone"))
		fake.imageOutcome = .image(makeImage())
		let unencodable = makeCapturer(fake) { _ in Data("not a png".utf8) }
		guard case .failed = thrownError({ try unencodable.capturePNG(pid: 100) }) else {
			Issue.record("expected failed for non-PNG encoder output"); return
		}
	}

	@Test func timeoutThrowsTimedOutWithTheConfiguredBound() {
		let fake = FakeCaptureEnvironment()
		fake.imageOutcome = .timedOut
		#expect(thrownError { try makeCapturer(fake, timeout: 0.25).capturePNG(pid: 100) } == .timedOut(after: 0.25))
	}

	@Test func defaultEvidenceBoundIsShorterThanTheFileCaptureDefault() {
		#expect(MacOSScreenCaptureKitWindowCapturer().options.timeout == MacOSScreenCaptureKitWindowCapturer.evidenceTimeout)
		#expect(MacOSScreenCaptureKitWindowCapturer.evidenceTimeout < MacOSWindowCaptureOptions().timeout)
	}
}
