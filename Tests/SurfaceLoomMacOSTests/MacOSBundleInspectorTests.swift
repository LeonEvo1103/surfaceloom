import SurfaceLoomMacOS
import Foundation
import Testing

@Suite("macOS bundle inspector contracts")
struct MacOSBundleInspectorTests {
	@Test("Purpose strings must be non-empty and missing keys preserve request order")
	func purposeStringValidation() throws {
		let app = try makeBundle(info: [
			"CFBundleIdentifier": "com.example.fixture",
			"CFBundleExecutable": "Fixture",
			"Allowed": "Used by deterministic tests",
			"Whitespace": "  \n ",
		])
		defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }

		let missing = try MacOSBundleInspector(appURL: app)
			.missingNonEmptyPurposeStrings(["Absent", "Allowed", "Whitespace"])
		#expect(missing == ["Absent", "Whitespace"])
	}

	@Test("Invalid bundles fail with an explicit appBundleMissing error")
	func invalidBundleFailsClearly() throws {
		let missing = FileManager.default.temporaryDirectory
			.appendingPathComponent("missing-\(UUID().uuidString).app")

		do {
			_ = try MacOSBundleInspector(appURL: missing)
				.missingNonEmptyPurposeStrings(["AnyKey"])
			Issue.record("Expected an invalid bundle to fail")
		} catch let error as DesktopAutomationError {
			guard case let .appBundleMissing(url) = error else {
				Issue.record("Expected appBundleMissing, received \(error)")
				return
			}
			#expect(url == missing)
		}
	}

	private func makeBundle(info: [String: Any]) throws -> URL {
		let root = FileManager.default.temporaryDirectory
			.appendingPathComponent(
				"surfaceloom-bundle-\(UUID().uuidString)",
				isDirectory: true
			)
		let app = root.appendingPathComponent("Fixture.app", isDirectory: true)
		let contents = app.appendingPathComponent("Contents", isDirectory: true)
		try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
		let plist = try PropertyListSerialization.data(
			fromPropertyList: info,
			format: .xml,
			options: 0
		)
		try plist.write(to: contents.appendingPathComponent("Info.plist"))
		return app
	}
}
