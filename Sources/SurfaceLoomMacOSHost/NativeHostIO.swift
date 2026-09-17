import Darwin
import Foundation
import SurfaceLoomNativeProtocol

final class NativeWireOutput: @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()
    private var failed = false

    init(_ handle: FileHandle) {
        self.handle = handle
    }

    func writeFrame(_ frame: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !failed else { throw CocoaError(.fileWriteUnknown) }
        guard frame.last == 0x0A, frame.count <= NativeProtocolV1.maxMessageBytes else {
            failed = true
            throw NativeProtocolError(code: "invalid_frame", message: "Outbound frame is incomplete or oversized.")
        }
        do {
            try handle.write(contentsOf: frame)
        } catch {
            failed = true
            throw error
        }
    }
}

enum NativeBrokenPipeProtection {
    private static let lock = NSLock()
    private static var processInstalled = false

    static func install() {
        // FileHandle.fileDescriptor raises an Objective-C exception for an
        // already-closed handle, so the host installs the reliable process-wide
        // disposition before either stdout or stderr can be touched.
        lock.withLock {
            guard !processInstalled else { return }
            _ = signal(SIGPIPE, SIG_IGN)
            processInstalled = true
        }
    }
}

final class NativeConnectionState: @unchecked Sendable {
    private let lock = NSLock()
    private let closeInput: @Sendable () -> Void
    private var outputFailed = false

    init(closeInput: @escaping @Sendable () -> Void) {
        self.closeInput = closeInput
    }

    var mayWriteOrExecute: Bool {
        lock.lock(); defer { lock.unlock() }
        return !outputFailed
    }

    var didFailOutput: Bool {
        lock.lock(); defer { lock.unlock() }
        return outputFailed
    }

    func failOutput() -> Bool {
        lock.lock()
        if outputFailed { lock.unlock(); return false }
        outputFailed = true
        lock.unlock()
        closeInput()
        return true
    }
}

final class NativeSafeDiagnostics: @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()

    init(_ handle: FileHandle) {
        self.handle = handle
    }

    func write(_ event: Event) {
        let line: String
        switch event {
        case .invalidInput: line = "Native input connection closed after an invalid frame.\n"
        case .ambiguousProtocol: line = "Native input connection closed because the protocol envelope was unsupported.\n"
        case .duplicateRequest: line = "Native input connection closed to preserve one terminal response.\n"
        case .outputFailure: line = "Native output stopped after a write failure.\n"
        case .inputFailure: line = "Native input reader stopped safely.\n"
        }
        lock.lock()
        defer { lock.unlock() }
        try? handle.write(contentsOf: Data(line.utf8))
    }

    enum Event {
        case invalidInput
        case ambiguousProtocol
        case duplicateRequest
        case outputFailure
        case inputFailure
    }
}
