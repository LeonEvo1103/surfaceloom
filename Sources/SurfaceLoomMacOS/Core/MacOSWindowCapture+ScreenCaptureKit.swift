import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

extension MacOSApplicationDriver {
	/// Writes a PNG of the bound application's frontmost normal window to `fileURL`.
	///
	/// Never requests Screen Recording access: without it the result is `.permissionNotGranted`
	/// and ScreenCaptureKit is not touched. The destination must not exist yet; missing parent
	/// directories are created. The call blocks for at most `options.timeout` while waiting for
	/// ScreenCaptureKit (on the main thread the run loop keeps being serviced meanwhile).
	public func captureBoundWindow(
		to fileURL: URL,
		options: MacOSWindowCaptureOptions = MacOSWindowCaptureOptions()
	) -> MacOSWindowCaptureResult {
		let ownerPID = application.map(\.processIdentifier).flatMap { isProcessAlive($0) ? $0 : nil }
		return MacOSWindowCapturer.capture(
			ownerPID: ownerPID,
			to: fileURL,
			options: options,
			dependencies: .live
		)
	}
}

extension MacOSWindowImageDependencies {
	static var live: Self {
		Self(
			isScreenCaptureGranted: { MacOSScreenCapturePermission.isGranted },
			listWindows: { MacOSWindowSelection.onScreenWindows() },
			captureImage: { MacOSScreenCaptureKitWindowImage.capture($0, timeout: $1) }
		)
	}
}

extension MacOSWindowCaptureDependencies {
	static var live: Self {
		Self(
			image: .live,
			writePNG: { MacOSPNGFileStore.write($0, to: $1) },
			verifiedPNGByteCount: { MacOSPNGFileStore.verifiedByteCount(at: $0) },
			fileExists: { FileManager.default.fileExists(atPath: $0.path) },
			removeFile: { try? FileManager.default.removeItem(at: $0) },
			now: { Date() }
		)
	}
}

/// Single-assignment slot with a bounded wait; late completions after a timeout are dropped.
final class MacOSBoundedResult<Value>: @unchecked Sendable {
	private let lock = NSLock()
	private let signal = DispatchSemaphore(value: 0)
	private var value: Value?

	func resolve(_ newValue: Value) {
		lock.lock()
		defer { lock.unlock() }
		guard value == nil else { return }
		value = newValue
		signal.signal()
	}

	func wait(timeout: TimeInterval) -> Value? {
		if let resolved = current { return resolved }
		let deadline = Date().addingTimeInterval(max(timeout, 0))
		if Thread.isMainThread {
			// Keep the main run loop (and main-queue callbacks) alive instead of blocking it.
			while signal.wait(timeout: .now()) != .success {
				guard Date() < deadline else { return nil }
				let slice = min(deadline, Date().addingTimeInterval(0.02))
				// A run loop without sources returns at once; sleep on the signal instead of spinning.
				if !RunLoop.current.run(mode: .default, before: slice),
					signal.wait(timeout: .now() + max(slice.timeIntervalSinceNow, 0)) == .success {
					break
				}
			}
		} else if signal.wait(timeout: .now() + max(timeout, 0)) != .success {
			return nil
		}
		return current
	}

	private var current: Value? {
		lock.lock()
		defer { lock.unlock() }
		return value
	}
}

/// ScreenCaptureKit backend. Callers must have passed the Screen Recording preflight first.
enum MacOSScreenCaptureKitWindowImage {
	static func capture(_ window: MacOSWindowDescriptor, timeout: TimeInterval) -> MacOSWindowImageOutcome {
		let result = MacOSBoundedResult<MacOSWindowImageOutcome>()
		let windowID = window.windowID
		let ownerPID = window.ownerPID
		SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
			guard let content else {
				result.resolve(.failed("listing shareable content failed: \(describe(error))"))
				return
			}
			guard let target = content.windows.first(where: { $0.windowID == windowID }) else {
				result.resolve(.windowUnavailable("window \(windowID) is no longer shareable"))
				return
			}
			guard target.owningApplication?.processID == ownerPID else {
				result.resolve(.windowUnavailable("window \(windowID) is not owned by pid \(ownerPID)"))
				return
			}
			// A desktop-independent window filter renders only this window, never what overlaps it.
			let filter = SCContentFilter(desktopIndependentWindow: target)
			let configuration = SCStreamConfiguration()
			let scale = CGFloat(filter.pointPixelScale)
			configuration.width = max(1, Int((filter.contentRect.width * scale).rounded()))
			configuration.height = max(1, Int((filter.contentRect.height * scale).rounded()))
			configuration.showsCursor = false
			configuration.captureResolution = .best
			SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
				if let image {
					result.resolve(.image(image))
				} else {
					result.resolve(.failed("ScreenCaptureKit returned no image: \(describe(error))"))
				}
			}
		}
		return result.wait(timeout: timeout) ?? .timedOut
	}

	private static func describe(_ error: Error?) -> String {
		error?.localizedDescription ?? "unknown error"
	}
}
