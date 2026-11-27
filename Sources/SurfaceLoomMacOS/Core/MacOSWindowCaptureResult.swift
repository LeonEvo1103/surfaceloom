import CoreGraphics
import Foundation

/// A PNG of exactly one window owned by the bound application, verified on disk.
public struct MacOSWindowCapture: Sendable, Equatable {
	public let fileURL: URL
	public let byteCount: Int
	public let pixelWidth: Int
	public let pixelHeight: Int
	public let windowID: CGWindowID
	public let ownerPID: pid_t
	public let capturedAt: Date

	public init(
		fileURL: URL,
		byteCount: Int,
		pixelWidth: Int,
		pixelHeight: Int,
		windowID: CGWindowID,
		ownerPID: pid_t,
		capturedAt: Date
	) {
		self.fileURL = fileURL
		self.byteCount = byteCount
		self.pixelWidth = pixelWidth
		self.pixelHeight = pixelHeight
		self.windowID = windowID
		self.ownerPID = ownerPID
		self.capturedAt = capturedAt
	}
}

/// Typed outcome of a bound-window capture. Only `.captured` carries an image; every other case
/// guarantees that no file was produced at the destination.
public enum MacOSWindowCaptureResult: Sendable, Equatable {
	case captured(MacOSWindowCapture)
	/// Screen Recording is not granted to the responsible process. Nothing that could show a
	/// system consent prompt was called; grant it manually in System Settings.
	case permissionNotGranted
	/// No live bound application, or none of its windows is capturable.
	case noCapturableWindow(reason: String)
	case failed(reason: String)
	case timedOut(after: TimeInterval)

	public var capture: MacOSWindowCapture? {
		if case let .captured(capture) = self { return capture }
		return nil
	}

	init(_ error: MacOSWindowCaptureError) {
		switch error {
		case .permissionNotGranted: self = .permissionNotGranted
		case let .noCapturableWindow(reason): self = .noCapturableWindow(reason: reason)
		case let .failed(reason): self = .failed(reason: reason)
		case let .timedOut(after): self = .timedOut(after: after)
		}
	}
}

/// Why an in-memory window capture produced no PNG; mirrors the non-captured result cases.
public enum MacOSWindowCaptureError: Error, Sendable, Equatable, CustomStringConvertible {
	/// Screen Recording is not granted; nothing that could show a consent prompt was called.
	case permissionNotGranted
	case noCapturableWindow(reason: String)
	case failed(reason: String)
	case timedOut(after: TimeInterval)

	public var description: String {
		switch self {
		case .permissionNotGranted: return "Screen Recording permission is not granted"
		case let .noCapturableWindow(reason): return "no capturable window: \(reason)"
		case let .failed(reason): return "window capture failed: \(reason)"
		case let .timedOut(after): return "window capture timed out after \(after)s"
		}
	}
}

public struct MacOSWindowCaptureOptions: Sendable, Equatable {
	/// Upper bound for the whole ScreenCaptureKit exchange (content lookup + screenshot).
	public let timeout: TimeInterval
	/// Windows smaller than this in either dimension (points) are not considered capturable.
	public let minimumWindowSize: CGSize

	public init(timeout: TimeInterval = 5, minimumWindowSize: CGSize = CGSize(width: 40, height: 40)) {
		self.timeout = max(timeout, 0)
		self.minimumWindowSize = minimumWindowSize
	}
}

/// Read-only Screen Recording state. Never requests access and never shows a prompt.
public enum MacOSScreenCapturePermission {
	public static var isGranted: Bool { CGPreflightScreenCaptureAccess() }
}
