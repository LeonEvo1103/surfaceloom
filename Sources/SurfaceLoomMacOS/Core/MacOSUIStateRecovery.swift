import Foundation

public struct MacOSUIStateTaintedError: LocalizedError {
	public let operationKey: String
	public let originalFailure: Error
	public let cleanupFailure: Error

	public init(
		operationKey: String,
		originalFailure: Error,
		cleanupFailure: Error
	) {
		self.operationKey = MacOSUIStateRecovery.requireSafeOperationKey(operationKey)
		self.originalFailure = originalFailure
		self.cleanupFailure = cleanupFailure
	}

	public var errorDescription: String? {
		"\(operationKey): cleanup could not prove that the UI baseline was restored"
	}
}

public final class MacOSUIStateTaintBarrier: @unchecked Sendable {
	private let lock = NSLock()
	private var storedCause: MacOSUIStateTaintedError?

	public init() {}

	public var cause: MacOSUIStateTaintedError? {
		lock.withLock { storedCause }
	}

	public var canBeginOperation: Bool { cause == nil }

	public func trip(_ cause: MacOSUIStateTaintedError) {
		lock.withLock {
			if storedCause == nil { storedCause = cause }
		}
	}

	public func requireClean() throws {
		if let cause { throw cause }
	}
}

public enum MacOSUIStateRecovery {
	private static let registryLock = NSLock()
	private static var barriers: [String: MacOSUIStateTaintBarrier] = [:]

	static func run<Result>(
		operationKey: String,
		barrier: MacOSUIStateTaintBarrier,
		body: () throws -> Result,
		recover: () throws -> Void,
		proveBaseline: () throws -> Void
	) throws -> Result {
		let key = requireSafeOperationKey(operationKey)
		try barrier.requireClean()
		do {
			let result = try body()
			try proveBaseline()
			return result
		} catch let taint as MacOSUIStateTaintedError {
			barrier.trip(taint)
			throw taint
		} catch {
			let originalFailure = error
			do {
				try recover()
				try proveBaseline()
			} catch {
				let taint = MacOSUIStateTaintedError(
					operationKey: key,
					originalFailure: originalFailure,
					cleanupFailure: error
				)
				barrier.trip(taint)
				throw taint
			}
			throw originalFailure
		}
	}

	static func markTainted(
		configuration: MacOSAppConfiguration,
		operationKey: String,
		originalFailure: Error,
		cleanupFailure: Error
	) -> MacOSUIStateTaintedError {
		let taint = MacOSUIStateTaintedError(
			operationKey: operationKey,
			originalFailure: originalFailure,
			cleanupFailure: cleanupFailure
		)
		barrier(for: configuration).trip(taint)
		return taint
	}

	static func failAfterRequiredCleanup(
		configuration: MacOSAppConfiguration,
		operationKey: String,
		originalFailure: Error,
		cleanup: () throws -> Void
	) throws -> Never {
		do {
			try cleanup()
		} catch {
			throw markTainted(
				configuration: configuration,
				operationKey: operationKey,
				originalFailure: originalFailure,
				cleanupFailure: error
			)
		}
		throw originalFailure
	}

	static func requireProcessStateClean(for configuration: MacOSAppConfiguration) throws {
		try barrier(for: configuration).requireClean()
	}

	static func run<Result>(
		configuration: MacOSAppConfiguration,
		operationKey: String,
		body: () throws -> Result,
		recover: () throws -> Void,
		proveBaseline: () throws -> Void
	) throws -> Result {
		try run(
			operationKey: operationKey,
			barrier: barrier(for: configuration),
			body: body,
			recover: recover,
			proveBaseline: proveBaseline
		)
	}

	private static func barrier(
		for configuration: MacOSAppConfiguration
	) -> MacOSUIStateTaintBarrier {
		let key = configuration.bundleIdentifier + "\u{0}" + configuration.appURL.path
		return registryLock.withLock {
			if let barrier = barriers[key] { return barrier }
			let barrier = MacOSUIStateTaintBarrier()
			barriers[key] = barrier
			return barrier
		}
	}

	@discardableResult
	static func requireSafeOperationKey(_ value: String) -> String {
		let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789._-")
		precondition(
			!value.isEmpty && value.utf8.count <= 96
				&& value.unicodeScalars.allSatisfy(allowed.contains),
			"UI recovery operation keys must be bounded lowercase identifiers"
		)
		return value
	}
}

extension MacOSApplicationDriver {
	public func withRecoverableUIStateChange<Result>(
		operationKey: String,
		body: () throws -> Result,
		recover: () throws -> Void,
		proveBaseline: () throws -> Void
	) throws -> Result {
		try MacOSUIStateRecovery.run(
			configuration: configuration,
			operationKey: operationKey,
			body: body,
			recover: recover,
			proveBaseline: proveBaseline
		)
	}
}
