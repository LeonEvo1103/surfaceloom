import Foundation

public enum MacOSDoctorStatus: String, CaseIterable, Hashable, Sendable {
	case pass
	case warn
	case fail
	case unsupported
}

public struct MacOSDoctorCheck: Equatable, Sendable {
	public let id: String
	public let status: MacOSDoctorStatus
	public let summary: String
	public let required: Bool
	public let details: [String: String]
	public let remediation: String?

	public init(
		id: String,
		status: MacOSDoctorStatus,
		summary: String,
		required: Bool,
		details: [String: String] = [:],
		remediation: String? = nil
	) {
		self.id = id
		self.status = status
		self.summary = summary
		self.required = required
		self.details = details
		self.remediation = remediation
	}
}

public struct MacOSDoctorReport: Equatable, Sendable {
	public let schemaVersion: String
	public let platform: String
	public let targetId: String
	public let generatedAt: Date
	public let readOnly: Bool
	public let overall: MacOSDoctorStatus
	public let canStartSession: Bool
	public let checks: [MacOSDoctorCheck]

	public init(
		schemaVersion: String,
		platform: String,
		targetId: String,
		generatedAt: Date,
		readOnly: Bool,
		overall: MacOSDoctorStatus,
		canStartSession: Bool,
		checks: [MacOSDoctorCheck]
	) {
		self.schemaVersion = schemaVersion
		self.platform = platform
		self.targetId = targetId
		self.generatedAt = generatedAt
		self.readOnly = readOnly
		self.overall = overall
		self.canStartSession = canStartSession
		self.checks = checks
	}
}
