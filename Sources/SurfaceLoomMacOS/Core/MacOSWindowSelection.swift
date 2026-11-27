import CoreGraphics
import Foundation

/// Platform-neutral snapshot of one Window Server entry, in front-to-back list order.
struct MacOSWindowDescriptor: Sendable, Equatable {
	let windowID: CGWindowID
	let ownerPID: pid_t
	let layer: Int
	let isOnScreen: Bool
	let alpha: Double
	let bounds: CGRect

	/// Parses a `CGWindowListCopyWindowInfo` entry; malformed entries yield nil and are ignored.
	init?(windowInfo: [String: Any]) {
		guard let windowID = (windowInfo[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
			let ownerPID = (windowInfo[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
			let layer = (windowInfo[kCGWindowLayer as String] as? NSNumber)?.intValue,
			let boundsInfo = windowInfo[kCGWindowBounds as String] as? NSDictionary,
			let bounds = CGRect(dictionaryRepresentation: boundsInfo as CFDictionary)
		else { return nil }
		self.init(
			windowID: windowID,
			ownerPID: ownerPID,
			layer: layer,
			isOnScreen: (windowInfo[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
			alpha: (windowInfo[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
			bounds: bounds
		)
	}

	init(windowID: CGWindowID, ownerPID: pid_t, layer: Int, isOnScreen: Bool, alpha: Double, bounds: CGRect) {
		self.windowID = windowID
		self.ownerPID = ownerPID
		self.layer = layer
		self.isOnScreen = isOnScreen
		self.alpha = alpha
		self.bounds = bounds
	}
}

enum MacOSWindowSelection {
	/// Selects the capture target: the frontmost (first in Window Server z-order) normal-layer,
	/// on-screen, visible window owned by `ownerPID` whose size reaches `minimumSize`.
	///
	/// Frontmost wins over largest because it is what the user (and the failing step) is
	/// looking at, e.g. a document window raised over a larger main window. Z-order is a total
	/// order, so the choice is deterministic for a given snapshot.
	static func select(
		from windows: [MacOSWindowDescriptor],
		ownerPID: pid_t,
		minimumSize: CGSize
	) -> MacOSWindowDescriptor? {
		windows.first { isCapturable($0, ownerPID: ownerPID, minimumSize: minimumSize) }
	}

	static func isCapturable(
		_ window: MacOSWindowDescriptor,
		ownerPID: pid_t,
		minimumSize: CGSize
	) -> Bool {
		window.ownerPID == ownerPID
			&& window.layer == 0
			&& window.isOnScreen
			&& window.alpha > 0
			&& window.bounds.width >= max(minimumSize.width, 1)
			&& window.bounds.height >= max(minimumSize.height, 1)
	}

	/// Live on-screen window list in front-to-back order. Reading owner, layer and bounds does
	/// not require Screen Recording and never prompts.
	static func onScreenWindows() -> [MacOSWindowDescriptor] {
		let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
		guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
			return []
		}
		return raw.compactMap(MacOSWindowDescriptor.init(windowInfo:))
	}
}
