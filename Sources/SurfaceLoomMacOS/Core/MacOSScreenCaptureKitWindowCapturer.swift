import CoreGraphics
import Foundation

/// `MacOSWindowCapturing` backed by the same selection, ScreenCaptureKit capture and bounded wait
/// as `captureBoundWindow(to:options:)`, returning the PNG in memory instead of writing a file.
///
/// It runs the read-only Screen Recording preflight itself and throws
/// `MacOSWindowCaptureError.permissionNotGranted` without touching ScreenCaptureKit, so callers
/// that use it directly can never trigger the system consent prompt.
public final class MacOSScreenCaptureKitWindowCapturer: MacOSWindowCapturing {
	/// Per-frame bound for action evidence. A recorder captures before and after every action,
	/// possibly on the main thread, so this bounds the worst-case delay a stuck capture adds to one
	/// action at 2 x 2 s instead of 2 x 5 s. Two seconds still covers a cold shareable-content
	/// lookup plus one single-window screenshot, which normally finish well under a second.
	public static let evidenceTimeout: TimeInterval = 2

	public let options: MacOSWindowCaptureOptions
	private let dependencies: MacOSWindowImageDependencies
	private let encodePNG: (CGImage) -> Data?

	public convenience init(
		options: MacOSWindowCaptureOptions = MacOSWindowCaptureOptions(timeout: evidenceTimeout)
	) {
		self.init(options: options, dependencies: .live, encodePNG: MacOSPNGEncoding.data(from:))
	}

	init(
		options: MacOSWindowCaptureOptions,
		dependencies: MacOSWindowImageDependencies,
		encodePNG: @escaping (CGImage) -> Data?
	) {
		self.options = options
		self.dependencies = dependencies
		self.encodePNG = encodePNG
	}

	/// Returns a PNG of the frontmost normal window owned by `pid`, or throws
	/// `MacOSWindowCaptureError`. Blocks for at most `options.timeout` on ScreenCaptureKit; on the
	/// main thread the run loop keeps being serviced meanwhile. A capture that misses the deadline
	/// throws `.timedOut` and its late completion is discarded.
	public func capturePNG(pid: pid_t) throws -> Data {
		guard let grant = MacOSWindowImageAcquisition.preflight(dependencies) else {
			throw MacOSWindowCaptureError.permissionNotGranted
		}
		let acquired = try MacOSWindowImageAcquisition.acquire(
			ownerPID: pid, options: options, dependencies: dependencies, grant: grant
		).get()
		guard let data = encodePNG(acquired.image), MacOSPNGEncoding.hasSignature(data) else {
			throw MacOSWindowCaptureError.failed(reason: "PNG encoding produced no valid PNG data")
		}
		return data
	}
}
