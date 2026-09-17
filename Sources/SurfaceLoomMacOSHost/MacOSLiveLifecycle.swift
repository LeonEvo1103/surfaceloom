import AppKit
import ApplicationServices
import Darwin
import Foundation

final class MacOSLivePlatform: MacOSHostPlatform, @unchecked Sendable {
    let messagingTimeout: MacOSAXMessagingTimeout

    init(messagingTimeout: MacOSAXMessagingTimeout = MacOSAXMessagingTimeout()) {
        self.messagingTimeout = messagingTimeout
    }

    var executableIdentity: MacOSExecutableIdentity {
        let rawName = Bundle.main.executableURL?.lastPathComponent
            ?? URL(fileURLWithPath: CommandLine.arguments.first ?? "host").lastPathComponent
        let name = String(rawName.prefix(128)).map {
            $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-") ? $0 : "_"
        }
        #if arch(arm64)
        let architecture = "arm64"
        #elseif arch(x86_64)
        let architecture = "x86_64"
        #else
        let architecture = "unknown"
        #endif
        return MacOSExecutableIdentity(
            processID: ProcessInfo.processInfo.processIdentifier,
            executableName: name.isEmpty ? "host" : String(name),
            bundleIdentifier: Bundle.main.bundleIdentifier,
            architecture: architecture
        )
    }

    func accessibilityTrusted() -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false]
        return AXIsProcessTrustedWithOptions(options as CFDictionary)
    }

    func validateLaunch(_ spec: MacOSLaunchSpec) throws {
        guard spec.workingDirectory == nil else {
            throw macOSBackendError("working_directory_unsupported", .unsupported,
                                    "macOS Launch Services does not support the requested working directory.")
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: spec.path, isDirectory: &isDirectory),
              isDirectory.boolValue,
              Bundle(url: URL(fileURLWithPath: spec.path))?.executableURL != nil else {
            throw macOSBackendError("executable_not_found", .notFound,
                                    "The requested application bundle was not found.")
        }
        let target = URL(fileURLWithPath: spec.path).resolvingSymlinksInPath().standardizedFileURL
        guard !NSWorkspace.shared.runningApplications.contains(where: {
            $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == target && !$0.isTerminated
        }) else {
            throw macOSBackendError("target_already_running", .conflict,
                                    "The requested application is already running.")
        }
    }

    func beginLaunch(
        _ spec: MacOSLaunchSpec,
        completion: @escaping @Sendable (Result<MacOSApplicationIdentity, NativeHostBackendError>) -> Void
    ) {
        let target = URL(fileURLWithPath: spec.path).resolvingSymlinksInPath().standardizedFileURL
        let priorCandidates = NSWorkspace.shared.runningApplications.filter {
            $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == target && !$0.isTerminated
        }
        let priorIdentities = priorCandidates.compactMap { identity(processID: $0.processIdentifier) }
        let prior = Set(priorIdentities)
        let priorIdentityIncomplete = priorIdentities.count != priorCandidates.count
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.arguments = spec.arguments
        configuration.createsNewApplicationInstance = true
        if !spec.environment.isEmpty {
            configuration.environment = ProcessInfo.processInfo.environment.merging(spec.environment) { _, value in value }
        }
        NSWorkspace.shared.openApplication(
            at: URL(fileURLWithPath: spec.path),
            configuration: configuration
        ) { [weak self] application, _ in
            guard let self else { return }
            guard let application,
                  let identity = self.identity(processID: application.processIdentifier) else {
                completion(.failure(macOSBackendError(
                    "launch_identity_unconfirmed", .backend,
                    "Launch Services did not return a stable application identity."
                )))
                return
            }
            guard !priorIdentityIncomplete else {
                completion(.failure(macOSBackendError(
                    "launch_identity_unconfirmed", .backend,
                    "A pre-existing target identity could not be excluded safely."
                )))
                return
            }
            guard !prior.contains(identity) else {
                completion(.failure(macOSBackendError(
                    "target_already_running", .conflict,
                    "Launch Services returned a pre-existing application instance."
                )))
                return
            }
            completion(.success(identity))
        }
    }

    func attach(processID: Int32) throws -> MacOSApplicationIdentity {
        guard processID > 0 else {
            throw macOSBackendError("session_target_not_found", .notFound,
                                    "The requested application process is not active.")
        }
        errno = 0
        let probe = kill(processID, 0)
        if probe != 0, errno == ESRCH {
            throw macOSBackendError("session_target_not_found", .notFound,
                                    "The requested application process is not active.")
        }
        guard probe == 0 || errno == EPERM, let identity = identity(processID: processID) else {
            throw macOSBackendError("application_identity_unconfirmed", .backend,
                                    "The application identity could not be established safely.")
        }
        return identity
    }

    func identityStatus(_ application: MacOSApplicationIdentity) -> MacOSIdentityStatus {
        errno = 0
        let probe = kill(application.processID, 0)
        if probe != 0, errno == ESRCH { return .provenStopped }
        guard probe == 0 || errno == EPERM,
              let start = processStart(application.processID) else { return .unconfirmed }
        guard start.0 == application.startSeconds, start.1 == application.startMicroseconds
        else { return .provenStopped }
        guard let running = NSRunningApplication(processIdentifier: application.processID),
              !running.isTerminated else { return .unconfirmed }
        if let expected = application.bundleIdentifier {
            guard let actual = running.bundleIdentifier, actual == expected else { return .unconfirmed }
        }
        return .current
    }

    func terminate(
        _ application: MacOSApplicationIdentity,
        force: Bool,
        timeoutMilliseconds: Int
    ) -> Bool {
        switch identityStatus(application) {
        case .provenStopped: return true
        case .unconfirmed: return false
        case .current: break
        }
        guard let running = NSRunningApplication(processIdentifier: application.processID),
              identityStatus(application) == .current else { return false }
        _ = force ? running.forceTerminate() : running.terminate()
        let deadline = DispatchTime.now().uptimeNanoseconds
            + UInt64(max(timeoutMilliseconds, 0)) * 1_000_000
        repeat {
            switch identityStatus(application) {
            case .provenStopped: return true
            case .unconfirmed: return false
            case .current: break
            }
            Thread.sleep(forTimeInterval: 0.02)
        } while DispatchTime.now().uptimeNanoseconds < deadline
        return identityStatus(application) == .provenStopped
    }

    private func identity(processID: Int32) -> MacOSApplicationIdentity? {
        guard processID > 0, kill(processID, 0) == 0 || errno == EPERM,
              let running = NSRunningApplication(processIdentifier: processID), !running.isTerminated,
              let start = processStart(processID) else { return nil }
        return MacOSApplicationIdentity(
            processID: processID,
            startSeconds: start.0,
            startMicroseconds: start.1,
            bundleIdentifier: running.bundleIdentifier
        )
    }

    private func processStart(_ processID: Int32) -> (UInt64, UInt64)? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(processID, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return (info.pbi_start_tvsec, info.pbi_start_tvusec)
    }
}
