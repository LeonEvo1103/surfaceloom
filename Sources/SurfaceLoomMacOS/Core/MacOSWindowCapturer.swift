import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// What the image backend produced for one selected window.
enum MacOSWindowImageOutcome {
	case image(CGImage)
	/// The selected window vanished or no longer belongs to the bound process.
	case windowUnavailable(String)
	case failed(String)
	case timedOut
}

/// Side effects every capture path needs, whatever it does with the image afterwards.
struct MacOSWindowImageDependencies {
	var isScreenCaptureGranted: () -> Bool
	var listWindows: () -> [MacOSWindowDescriptor]
	var captureImage: (_ window: MacOSWindowDescriptor, _ timeout: TimeInterval) -> MacOSWindowImageOutcome
}

/// Injection seam of the file path: every side effect of a capture goes through here, so the
/// decision flow is testable without Screen Recording, a window server or a file system.
struct MacOSWindowCaptureDependencies {
	var image: MacOSWindowImageDependencies
	/// Returns nil on success, otherwise a failure reason.
	var writePNG: (_ image: CGImage, _ fileURL: URL) -> String?
	/// Returns the on-disk byte count only for a non-empty file with a PNG signature.
	var verifiedPNGByteCount: (_ fileURL: URL) -> Int?
	var fileExists: (_ fileURL: URL) -> Bool
	var removeFile: (_ fileURL: URL) -> Void
	var now: () -> Date
}

/// Proof that the read-only Screen Recording preflight passed. Only `preflight` can make one, so
/// no path can reach the image backend (and a possible consent prompt) without checking first.
struct MacOSScreenCaptureGrant {
	fileprivate init() {}
}

struct MacOSAcquiredWindowImage {
	let window: MacOSWindowDescriptor
	let image: CGImage
}

/// The single selection -> bounded capture -> pixel check core behind both the file path
/// (`captureBoundWindow(to:options:)`) and the in-memory path (`MacOSScreenCaptureKitWindowCapturer`).
enum MacOSWindowImageAcquisition {
	static func preflight(_ dependencies: MacOSWindowImageDependencies) -> MacOSScreenCaptureGrant? {
		dependencies.isScreenCaptureGranted() ? MacOSScreenCaptureGrant() : nil
	}

	static func acquire(
		ownerPID: pid_t,
		options: MacOSWindowCaptureOptions,
		dependencies: MacOSWindowImageDependencies,
		grant _: MacOSScreenCaptureGrant
	) -> Result<MacOSAcquiredWindowImage, MacOSWindowCaptureError> {
		guard let window = MacOSWindowSelection.select(
			from: dependencies.listWindows(),
			ownerPID: ownerPID,
			minimumSize: options.minimumWindowSize
		) else {
			return .failure(.noCapturableWindow(
				reason: "no on-screen layer-0 window of at least "
					+ "\(Int(options.minimumWindowSize.width))x\(Int(options.minimumWindowSize.height)) "
					+ "points is owned by pid \(ownerPID)"
			))
		}
		switch dependencies.captureImage(window, options.timeout) {
		case let .image(image):
			guard image.width > 0, image.height > 0 else {
				return .failure(.failed(reason: "the window image has no pixels"))
			}
			return .success(MacOSAcquiredWindowImage(window: window, image: image))
		case .timedOut: return .failure(.timedOut(after: options.timeout))
		case let .windowUnavailable(reason): return .failure(.noCapturableWindow(reason: reason))
		case let .failed(reason): return .failure(.failed(reason: reason))
		}
	}
}

/// File path: writes the acquired image to a new file and verifies it on disk.
enum MacOSWindowCapturer {
	static func capture(
		ownerPID: pid_t?,
		to fileURL: URL,
		options: MacOSWindowCaptureOptions,
		dependencies: MacOSWindowCaptureDependencies
	) -> MacOSWindowCaptureResult {
		guard let ownerPID else {
			return .noCapturableWindow(reason: "no live bound application")
		}
		// Preflight before anything that may reach ScreenCaptureKit: an unauthorized SCK call can
		// show the system consent prompt, which a test runner must never trigger.
		guard let grant = MacOSWindowImageAcquisition.preflight(dependencies.image) else {
			return .permissionNotGranted
		}
		guard fileURL.isFileURL else { return .failed(reason: "destination is not a file URL") }
		guard !dependencies.fileExists(fileURL) else {
			return .failed(reason: "destination already exists: \(fileURL.lastPathComponent)")
		}
		let acquired: MacOSAcquiredWindowImage
		switch MacOSWindowImageAcquisition.acquire(
			ownerPID: ownerPID, options: options, dependencies: dependencies.image, grant: grant
		) {
		case let .success(value): acquired = value
		case let .failure(error): return MacOSWindowCaptureResult(error)
		}
		if let reason = dependencies.writePNG(acquired.image, fileURL) {
			dependencies.removeFile(fileURL)
			return .failed(reason: "writing PNG failed: \(reason)")
		}
		guard let byteCount = dependencies.verifiedPNGByteCount(fileURL), byteCount > 0 else {
			dependencies.removeFile(fileURL)
			return .failed(reason: "the PNG was not found on disk as a non-empty PNG file")
		}
		return .captured(
			MacOSWindowCapture(
				fileURL: fileURL,
				byteCount: byteCount,
				pixelWidth: acquired.image.width,
				pixelHeight: acquired.image.height,
				windowID: acquired.window.windowID,
				ownerPID: ownerPID,
				capturedAt: dependencies.now()
			)
		)
	}
}

/// In-memory PNG encoding shared by the file store and the in-memory capturer.
enum MacOSPNGEncoding {
	static let signature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

	static func data(from image: CGImage) -> Data? {
		let buffer = NSMutableData()
		guard let destination = CGImageDestinationCreateWithData(
			buffer as CFMutableData,
			UTType.png.identifier as CFString,
			1,
			nil
		) else { return nil }
		CGImageDestinationAddImage(destination, image, nil)
		guard CGImageDestinationFinalize(destination) else { return nil }
		return hasSignature(buffer as Data) ? buffer as Data : nil
	}

	static func hasSignature(_ data: Data) -> Bool {
		data.count > signature.count && data.prefix(signature.count).elementsEqual(signature)
	}
}

/// File-system half of the live dependencies.
enum MacOSPNGFileStore {
	static func write(_ image: CGImage, to fileURL: URL) -> String? {
		do {
			try FileManager.default.createDirectory(
				at: fileURL.deletingLastPathComponent(),
				withIntermediateDirectories: true
			)
		} catch {
			return "cannot create the destination directory: \(error.localizedDescription)"
		}
		guard let data = MacOSPNGEncoding.data(from: image) else { return "PNG encoding did not finalize" }
		do {
			try data.write(to: fileURL, options: .atomic)
			return nil
		} catch {
			return error.localizedDescription
		}
	}

	static func verifiedByteCount(at fileURL: URL) -> Int? {
		let signature = MacOSPNGEncoding.signature
		guard let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
			let size = (attributes[.size] as? NSNumber)?.intValue, size > signature.count,
			let handle = try? FileHandle(forReadingFrom: fileURL)
		else { return nil }
		defer { try? handle.close() }
		guard let header = try? handle.read(upToCount: signature.count), Array(header) == signature else {
			return nil
		}
		return size
	}
}
