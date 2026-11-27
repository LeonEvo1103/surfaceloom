import CoreGraphics
import Foundation
import Testing
@testable import SurfaceLoomMacOS

func makeWindow(
	_ id: CGWindowID,
	pid: pid_t = 100,
	layer: Int = 0,
	onScreen: Bool = true,
	alpha: Double = 1,
	size: CGSize = CGSize(width: 800, height: 600)
) -> MacOSWindowDescriptor {
	MacOSWindowDescriptor(
		windowID: id, ownerPID: pid, layer: layer, isOnScreen: onScreen, alpha: alpha,
		bounds: CGRect(origin: CGPoint(x: 10, y: 20), size: size)
	)
}

struct MacOSWindowSelectionTests {
	let minimum = CGSize(width: 40, height: 40)

	@Test func picksFrontmostAmongSeveralOwnedWindows() {
		let windows = [makeWindow(7, size: CGSize(width: 300, height: 200)), makeWindow(8), makeWindow(9)]
		#expect(MacOSWindowSelection.select(from: windows, ownerPID: 100, minimumSize: minimum)?.windowID == 7)
	}

	@Test func skipsOverlayPictureInPictureAndMenuLayers() {
		let windows = [makeWindow(1, layer: 3), makeWindow(2, layer: 25), makeWindow(3, layer: -1), makeWindow(4)]
		#expect(MacOSWindowSelection.select(from: windows, ownerPID: 100, minimumSize: minimum)?.windowID == 4)
		#expect(MacOSWindowSelection.select(from: Array(windows.prefix(3)), ownerPID: 100, minimumSize: minimum) == nil)
	}

	@Test func zeroSizedTinyHiddenAndTransparentWindowsAreNotCapturable() {
		let windows = [
			makeWindow(1, size: .zero),
			makeWindow(2, size: CGSize(width: 800, height: 0)),
			makeWindow(3, size: CGSize(width: 20, height: 20)),
			makeWindow(4, onScreen: false),
			makeWindow(5, alpha: 0),
		]
		#expect(MacOSWindowSelection.select(from: windows, ownerPID: 100, minimumSize: minimum) == nil)
		#expect(MacOSWindowSelection.select(from: windows, ownerPID: 100, minimumSize: .zero)?.windowID == 3)
	}

	@Test func ignoresWindowsOfOtherProcessesEvenWhenFrontmost() {
		let windows = [makeWindow(1, pid: 555), makeWindow(2, pid: 100, size: CGSize(width: 100, height: 100))]
		#expect(MacOSWindowSelection.select(from: windows, ownerPID: 100, minimumSize: minimum)?.windowID == 2)
		#expect(MacOSWindowSelection.select(from: windows, ownerPID: 777, minimumSize: minimum) == nil)
	}

	@Test func parsesWindowServerEntriesAndRejectsMalformedOnes() throws {
		let bounds = CGRect(x: 1, y: 2, width: 640, height: 480).dictionaryRepresentation
		let entry: [String: Any] = [
			kCGWindowNumber as String: NSNumber(value: 42),
			kCGWindowOwnerPID as String: NSNumber(value: 100),
			kCGWindowLayer as String: NSNumber(value: 0),
			kCGWindowIsOnscreen as String: NSNumber(value: true),
			kCGWindowAlpha as String: NSNumber(value: 1.0),
			kCGWindowBounds as String: bounds,
		]
		let parsed = try #require(MacOSWindowDescriptor(windowInfo: entry))
		#expect(parsed == MacOSWindowDescriptor(
			windowID: 42, ownerPID: 100, layer: 0, isOnScreen: true, alpha: 1,
			bounds: CGRect(x: 1, y: 2, width: 640, height: 480)
		))
		var missingLayer = entry
		missingLayer.removeValue(forKey: kCGWindowLayer as String)
		#expect(MacOSWindowDescriptor(windowInfo: missingLayer) == nil)
		var missingOnScreen = entry
		missingOnScreen.removeValue(forKey: kCGWindowIsOnscreen as String)
		#expect(MacOSWindowDescriptor(windowInfo: missingOnScreen)?.isOnScreen == false)
	}
}
