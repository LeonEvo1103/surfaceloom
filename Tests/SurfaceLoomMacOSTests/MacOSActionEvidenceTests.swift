import Foundation
import Testing
@testable import SurfaceLoomMacOS

@Suite("macOS 动作取证契约", .serialized)
struct MacOSActionEvidenceTests {
	@Test("动作失败只执行一次，并保留前后截图与原始错误")
	func failedActionRetainsEvidence() throws {
		try withEvidence { evidence, directory, capturer in
			var executions = 0
			#expect(throws: EvidenceTestError.action) {
				try MacOSActionEvidence.perform(action: "press", target: "AXButton:confirm", pid: 42) {
					executions += 1
					throw EvidenceTestError.action
				}
			}
			let manifest = try evidence.finalize(outcome: "failed")
			#expect(executions == 1)
			#expect(capturer.calls == [42, 42])
			#expect(manifest.captureStatus == "captured")
			#expect(manifest.artifacts.count == 3)
			#expect(manifest.artifacts.allSatisfy { $0.sensitive })
			for name in ["1-before.png", "1-after.png", "trace.jsonl", "manifest.json"] {
				#expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path))
			}
			let events = try readEvents(directory)
			#expect(events.count == 1)
			#expect(events.first?["result"] == "failed")
			#expect(events.first?["action"] == "press")
		}
	}

	@Test("成功时仅清理本次生成的截图，保留目录中的其他文件")
	func successfulActionOnlyRemovesOwnedImages() throws {
		try withEvidence { evidence, directory, _ in
			let existing = directory.appendingPathComponent("unrelated.png")
			try Data("existing".utf8).write(to: existing)
			MacOSActionEvidence.perform(action: "click", target: "AXButton", pid: 42) {}
			let manifest = try evidence.finalize(outcome: "passed")
			#expect(try Data(contentsOf: existing) == Data("existing".utf8))
			#expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("1-before.png").path))
			#expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("1-after.png").path))
			#expect(manifest.artifacts.map(\.kind) == ["trace"])
			#expect(try readEvents(directory).first?["result"] == "completed")
		}
	}

	@Test("截图名称冲突不覆盖或清理已有文件")
	func existingCapturePathIsPreserved() throws {
		try withEvidence { evidence, directory, _ in
			let existing = directory.appendingPathComponent("1-before.png")
			let original = Data("previous run".utf8)
			try original.write(to: existing)
			MacOSActionEvidence.perform(action: "click", target: "AXButton", pid: 42) {}
			let manifest = try evidence.finalize(outcome: "passed")
			#expect(try Data(contentsOf: existing) == original)
			#expect(manifest.captureStatus == "captureFailed")
			#expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("1-after.png").path))
			#expect(try readEvents(directory).first?["before"] == "captureFailed")
		}
	}

	@Test("未授权截图时仍执行动作，且不调用截图后端")
	func missingPermissionDoesNotCapture() throws {
		try withEvidence(permission: false) { evidence, directory, capturer in
			var executions = 0
			MacOSActionEvidence.perform(action: "shortcut", target: "enter", pid: 42) { executions += 1 }
			let manifest = try evidence.finalize(outcome: "failed")
			#expect(executions == 1)
			#expect(capturer.calls.isEmpty)
			#expect(manifest.captureStatus == "unsupported")
			#expect(try readEvents(directory).first?["result"] == "completed")
			#expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("1-before.png").path))
		}
	}

	@Test("截图失败不能吞掉或替换动作错误")
	func captureFailurePreservesActionError() throws {
		try withEvidence(captureFails: true) { evidence, directory, capturer in
			#expect(throws: EvidenceTestError.action) {
				try MacOSActionEvidence.perform(action: "press", target: "AXButton", pid: 42) {
					throw EvidenceTestError.action
				}
			}
			let manifest = try evidence.finalize(outcome: "failed")
			#expect(capturer.calls.count == 2)
			#expect(manifest.captureStatus == "captureFailed")
			#expect(try readEvents(directory).first?["result"] == "failed")
		}
	}

	private func withEvidence(
		permission: Bool = true, captureFails: Bool = false,
		_ body: (MacOSActionEvidence, URL, EvidenceTestCapturer) throws -> Void
	) throws {
		let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		defer {
			MacOSActionEvidence.clear()
			try? FileManager.default.removeItem(at: directory)
		}
		let capturer = EvidenceTestCapturer(fails: captureFails)
		let evidence = MacOSActionEvidence(directory: directory, permission: { permission }, capturer: capturer)
		MacOSActionEvidence.install(evidence)
		try body(evidence, directory, capturer)
	}

	private func readEvents(_ directory: URL) throws -> [[String: String]] {
		let data = try Data(contentsOf: directory.appendingPathComponent("manifest.json"))
		let manifest = try #require(JSONSerialization.jsonObject(with: data) as? [String: [[String: String]]])
		return try #require(manifest["events"])
	}
}

private enum EvidenceTestError: Error { case action, capture }

private final class EvidenceTestCapturer: MacOSWindowCapturing {
	let fails: Bool
	var calls: [pid_t] = []
	init(fails: Bool) { self.fails = fails }
	func capturePNG(pid: pid_t) throws -> Data {
		calls.append(pid)
		if fails { throw EvidenceTestError.capture }
		return Data([137, 80, 78, 71])
	}
}
