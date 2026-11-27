import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

public protocol MacOSWindowCapturing: AnyObject {
	func capturePNG(pid: pid_t) throws -> Data
}

public struct MacOSEvidenceArtifact: Equatable {
	public var id: String
	public var kind: String
	public var phase: String
	public var path: String
	public var captureStatus: String
	public var sensitive: Bool
}

public struct MacOSEvidenceManifest: Equatable {
	public var artifacts: [MacOSEvidenceArtifact]
	public var captureStatus: String
}

enum MacOSEvidenceError: Error { case captureFailed }

/// Diagnostic frames and a semantic trace. Not a replay script.
public final class MacOSActionEvidence {
	public static let sharedLock = NSLock()
	private static var installed: MacOSActionEvidence?
	private let directory: URL
	private let permission: () -> Bool
	private let capturer: MacOSWindowCapturing
	private var events: [[String: String]] = []
	private var sequence = 0
	private var capturedPaths: Set<URL> = []

	public init(directory: URL, permission: @escaping () -> Bool, capturer: MacOSWindowCapturing) {
		self.directory = directory
		self.permission = permission
		self.capturer = capturer
	}

	public static func live(directory: URL) -> MacOSActionEvidence {
		MacOSActionEvidence(directory: directory, permission: { CGPreflightScreenCaptureAccess() }, capturer: MacOSCGWindowCapturer())
	}

	public static func install(_ evidence: MacOSActionEvidence) {
		sharedLock.lock(); installed = evidence; sharedLock.unlock()
	}

	public static func clear() {
		sharedLock.lock(); installed = nil; sharedLock.unlock()
	}

	static func perform(action: String, target: String, pid: pid_t, _ body: () throws -> Void) rethrows {
		sharedLock.lock(); let evidence = installed; sharedLock.unlock()
		let opened = evidence?.open(action: action, target: target, pid: pid)
		do {
			try body()
			evidence?.close(opened, result: "completed", pid: pid)
		} catch {
			evidence?.close(opened, result: "failed", pid: pid)
			throw error
		}
	}

	public func finalize(outcome: String) throws -> MacOSEvidenceManifest {
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		let keepImages = outcome == "failed" || outcome == "timeout"
		if !keepImages {
			for path in capturedPaths {
				try FileManager.default.removeItem(at: path)
			}
			capturedPaths.removeAll()
		}
		let lines = events.map { event -> String in
			let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
			return String(data: data ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
		}
		try (lines.joined(separator: "\n") + (lines.isEmpty ? "" : "\n")).write(
			to: directory.appendingPathComponent("trace.jsonl"), atomically: true, encoding: .utf8)
		let payload = try JSONSerialization.data(withJSONObject: ["events": events], options: [.prettyPrinted, .sortedKeys])
		try payload.write(to: directory.appendingPathComponent("manifest.json"), options: .atomic)
		return MacOSEvidenceManifest(artifacts: artifacts(keepImages: keepImages), captureStatus: overallStatus)
	}

	private var overallStatus: String {
		let statuses = events.flatMap { [$0["before"], $0["after"]] }.compactMap { $0 }
		if statuses.isEmpty { return "captured" }
		if statuses.allSatisfy({ $0 == "unsupported" }) { return "unsupported" }
		if statuses.contains("captureFailed") { return "captureFailed" }
		return "captured"
	}

	private func artifacts(keepImages: Bool) -> [MacOSEvidenceArtifact] {
		let folder = directory.lastPathComponent
		var items = [MacOSEvidenceArtifact(id: "trace", kind: "trace", phase: "trace", path: "\(folder)/trace.jsonl", captureStatus: events.isEmpty ? "captured" : overallStatus, sensitive: true)]
		guard keepImages else { return items }
		for event in events {
			guard let sequence = event["sequence"] else { continue }
			for phase in ["before", "after"] {
				items.append(MacOSEvidenceArtifact(id: "\(sequence)-\(phase)", kind: "screenshot", phase: phase, path: "\(folder)/\(sequence)-\(phase).png", captureStatus: event[phase] ?? "captureFailed", sensitive: true))
			}
		}
		return items
	}

	private func open(action: String, target: String, pid: pid_t) -> Int {
		sequence += 1
		events.append(["sequence": String(sequence), "action": action, "target": sanitized(target), "startedAt": timestamp(), "before": capture(sequence: sequence, phase: "before", pid: pid), "result": "started"])
		return sequence
	}

	private func close(_ sequence: Int?, result: String, pid: pid_t) {
		guard let sequence, let index = events.firstIndex(where: { $0["sequence"] == String(sequence) }) else { return }
		events[index]["after"] = capture(sequence: sequence, phase: "after", pid: pid)
		events[index]["endedAt"] = timestamp()
		events[index]["result"] = result
	}

	private func capture(sequence: Int, phase: String, pid: pid_t) -> String {
		guard permission() else { return "unsupported" }
		do {
			let data = try capturer.capturePNG(pid: pid)
			guard !data.isEmpty else { return "captureFailed" }
			try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
			let path = directory.appendingPathComponent("\(sequence)-\(phase).png")
			try data.write(to: path, options: .withoutOverwriting)
			capturedPaths.insert(path)
			return "captured"
		} catch { return "captureFailed" }
	}

	private func sanitized(_ target: String) -> String {
		let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._:-"))
		let clean = String(target.unicodeScalars.filter { allowed.contains($0) }.prefix(64))
		return clean.isEmpty ? "element" : clean
	}

	private func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }
}

enum MacOSActionTarget {
	static func identifier(of element: AXUIElement) -> String {
		let role = string(kAXRoleAttribute, of: element)
		let rawID = string(kAXIdentifierAttribute, of: element) ?? ""
		let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._:-"))
		let cleanID = String(rawID.unicodeScalars.filter { allowed.contains($0) }.prefix(64))
		if let role, !cleanID.isEmpty { return "\(role):\(cleanID)" }
		return role ?? "element"
	}

	static func shortcutName(_ shortcut: MacOSShortcut) -> String {
		switch shortcut {
		case .commandW: return "commandW"
		case .commandQ: return "commandQ"
		case .commandShiftG: return "commandShiftG"
		case .arrowDown: return "arrowDown"
		case .enter: return "enter"
		case .escape: return "escape"
		default: return "shortcut"
		}
	}

	private static func string(_ attribute: String, of element: AXUIElement) -> String? {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let text = value as? String, !text.isEmpty else { return nil }
		return text
	}
}

final class MacOSCGWindowCapturer: MacOSWindowCapturing {
	func capturePNG(pid: pid_t) throws -> Data {
		guard let windowID = windowID(pid: pid),
			let image = CGWindowListCreateImage(.null, .optionIncludingWindow, windowID, [.boundsIgnoreFraming]),
			let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), !data.isEmpty
		else { throw MacOSEvidenceError.captureFailed }
		return data
	}

	private func windowID(pid: pid_t) -> CGWindowID? {
		guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
		for window in info {
			guard (window[kCGWindowOwnerPID as String] as? Int) == Int(pid), (window[kCGWindowLayer as String] as? Int ?? 0) == 0,
				let number = window[kCGWindowNumber as String] as? Int else { continue }
			return CGWindowID(number)
		}
		return nil
	}
}
