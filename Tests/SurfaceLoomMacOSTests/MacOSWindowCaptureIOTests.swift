import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import SurfaceLoomMacOS

struct MacOSWindowCaptureIOTests {
	@Test func boundedResultTimesOutWhenNeverResolved() {
		let slot = MacOSBoundedResult<Int>()
		let started = Date()
		#expect(slot.wait(timeout: 0.2) == nil)
		let elapsed = Date().timeIntervalSince(started)
		#expect(elapsed >= 0.15 && elapsed < 2)
	}

	@Test func boundedResultKeepsFirstValueAndDropsLateCompletions() {
		let slot = MacOSBoundedResult<Int>()
		DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { slot.resolve(1); slot.resolve(2) }
		#expect(slot.wait(timeout: 2) == 1)
		#expect(slot.wait(timeout: 0) == 1)
	}

	@MainActor @Test func boundedResultOnTheMainThreadReturnsLateValueOrTimesOut() {
		#expect(Thread.isMainThread)
		let slot = MacOSBoundedResult<Int>()
		DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { slot.resolve(7) }
		#expect(slot.wait(timeout: 2) == 7)
		let started = Date()
		#expect(MacOSBoundedResult<Int>().wait(timeout: 0.2) == nil)
		let elapsed = Date().timeIntervalSince(started)
		#expect(elapsed >= 0.15 && elapsed < 2)
	}

	@Test func pngEncodingProducesSignedDataThatDecodes() throws {
		let data = try #require(MacOSPNGEncoding.data(from: makeImage(width: 6, height: 2)))
		#expect(MacOSPNGEncoding.hasSignature(data))
		let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
		let decoded = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
		#expect(decoded.width == 6 && decoded.height == 2)
		#expect(!MacOSPNGEncoding.hasSignature(Data(MacOSPNGEncoding.signature)))
	}

	@Test func pngStoreRoundTripsARealFileAndRejectsNonPNG() throws {
		let directory = FileManager.default.temporaryDirectory
			.appendingPathComponent("surfaceloom-capture-\(UUID().uuidString)", isDirectory: true)
		defer { try? FileManager.default.removeItem(at: directory) }
		let png = directory.appendingPathComponent("nested/window.png")
		#expect(MacOSPNGFileStore.write(makeImage(width: 9, height: 5), to: png) == nil)
		let bytes = try #require(MacOSPNGFileStore.verifiedByteCount(at: png))
		#expect(bytes > 8)
		let source = try #require(CGImageSourceCreateWithURL(png as CFURL, nil))
		let decoded = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
		#expect(decoded.width == 9 && decoded.height == 5)

		let text = directory.appendingPathComponent("not-png.png")
		try Data("definitely not a png file".utf8).write(to: text)
		#expect(MacOSPNGFileStore.verifiedByteCount(at: text) == nil)
		let empty = directory.appendingPathComponent("empty.png")
		try Data().write(to: empty)
		#expect(MacOSPNGFileStore.verifiedByteCount(at: empty) == nil)
		#expect(MacOSPNGFileStore.verifiedByteCount(at: directory.appendingPathComponent("missing.png")) == nil)
	}
}
