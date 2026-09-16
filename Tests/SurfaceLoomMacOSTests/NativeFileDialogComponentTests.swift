import Foundation
import Testing
@testable import SurfaceLoomMacOS

@Suite("native file-dialog component contracts")
struct NativeFileDialogComponentTests {
	@Test("Directory selection rejects non-file URLs before UI interaction")
	func rejectsNonFileURL() {
		let component = makeComponent()
		#expect(throws: DesktopAutomationError.self) {
			try component.selectDirectory(at: URL(string: "https://example.invalid/folder")!)
		}
	}

	@Test("Directory selection rejects regular files before UI interaction")
	func rejectsRegularFile() throws {
		let file = FileManager.default.temporaryDirectory.appendingPathComponent(
			"surfaceloom-file-dialog-\(UUID().uuidString)"
		)
		try Data("not a directory".utf8).write(to: file, options: .withoutOverwriting)
		defer { try? FileManager.default.removeItem(at: file) }

		let component = makeComponent()
		#expect(throws: DesktopAutomationError.self) {
			try component.selectDirectory(at: file)
		}
	}

	private func makeComponent() -> NativeFileDialogComponent {
		let configuration = MacOSAppConfiguration(
			appURL: URL(fileURLWithPath: "/Applications/Contract.app"),
			bundleIdentifier: "com.example.surfaceloom.file-dialog.\(UUID())",
			displayName: "Contract"
		)
		return NativeFileDialogComponent(
			driver: MacOSApplicationDriver(configuration: configuration)
		)
	}
}
