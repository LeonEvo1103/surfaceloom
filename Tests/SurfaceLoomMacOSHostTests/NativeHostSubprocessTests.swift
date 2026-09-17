import Foundation
import Testing
import SurfaceLoomNativeProtocol
@testable import SurfaceLoomMacOSHost

@Suite("macOS host subprocess hardening")
struct NativeHostSubprocessTests {
    @Test("Host process redacts hostile unknown keys and emits one terminal frame")
    func hostileUnknownKeys() throws {
        let executable = try buildFixture()
        let hostileKeys = [
            "unknown\\nfield",
            "unknown\\u0000field",
            String(repeating: "q", count: 2_050),
            "/Users/example/private-token",
        ]
        for (index, key) in hostileKeys.enumerated() {
            let id = "hostile-\(index)"
            let malformed = "{\"protocol\":\"surfaceloom.native\",\"version\":\"1.0\"," +
                "\"type\":\"request\",\"id\":\"\(id)\",\"\(key)\":true," +
                "\"deadline\":{\"timeoutMs\":1000},\"call\":{\"name\":\"host.handshake\"," +
                "\"intent\":\"observe\",\"scope\":{\"kind\":\"bootstrap\"},\"payload\":{}}}"
            let trailing = NativeHostContractTests().handshake(id: "must-not-run")
            let result = try runProcess(executable, input: malformed + "\n" + trailing + "\n")
            #expect(result.status == 0)
            #expect(result.stderr.isEmpty)
            #expect(!result.stdout.contains("private-token"))
            #expect(!result.stdout.contains(key))
            if index == 0 { #expect(!result.stdout.contains("unknown\nfield")) }
            if index == 1 { #expect(!result.stdout.contains("unknown\0field")) }
            #expect(!result.stdout.contains(String(repeating: "q", count: 64)))
            let responses = try NativeHostContractTests().responseLines(Data(result.stdout.utf8))
            #expect(responses.count == 1)
            #expect(responses.first?.id == id)
            #expect(responses.first?.error?.code == "invalid_message")
            #expect(responses.first?.operation == nil)
        }

        let handshake = try runProcess(executable, input: NativeHostContractTests().handshake(id: "real-host") + "\n")
        let response = try NativeHostContractTests().responseLines(Data(handshake.stdout.utf8)).first!
        guard case let .object(host)? = response.result,
              case let .array(methods)? = host["methods"] else {
            Issue.record("Missing real backend handshake")
            return
        }
        #expect(host["backend"] == .string("ax"))
        #expect(methods.count == MacOSHostMethod.advertised.count)
    }

    @Test("Broken stdout and stderr become EPIPE and still run shutdown")
    func brokenOutputDoesNotSignal() throws {
        let main = """
        import Darwin
        import Foundation
        import SurfaceLoomNativeProtocol
        import SurfaceLoomMacOSHost

        final class MarkerBackend: NativeHostBackend, @unchecked Sendable {
            let marker: String
            let descriptor = NativeHostDescriptor(
                hostInstanceID: "broken-pipe", platform: "macos", backend: "fixture",
                methods: [NativeMethodDescriptor(
                    name: "host.handshake", intent: .observe, scopeKinds: ["bootstrap"]
                )]
            )
            init(marker: String) { self.marker = marker }
            func prepare(
                request: NativeRequest,
                context: NativeHostExecutionContext
            ) throws -> NativeHostBackendCommand {
                _ = request; _ = context
                return NativeHostBackendCommand { self.descriptor.jsonValue }
            }
            func shutdown() -> Bool {
                FileManager.default.createFile(
                    atPath: marker, contents: Data("shutdown\\n".utf8)
                )
            }
        }

        let marker = CommandLine.arguments[1]
        let dispatcher = NativeHostDispatcher(backend: MarkerBackend(marker: marker))
        exit(NativeStdioHost(dispatcher: dispatcher).run())
        """
        let executable = try buildFixture(mainSource: main)
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("surfaceloom-shutdown-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: marker) }
        let process = Process()
        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = executable
        process.arguments = [marker.path]
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        stdout.fileHandleForReading.closeFile()
        stderr.fileHandleForReading.closeFile()
        stdin.fileHandleForWriting.write(Data((NativeHostContractTests().handshake(id: "pipe") + "\n").utf8))
        stdin.fileHandleForWriting.closeFile()
        process.waitUntilExit()
        #expect(process.terminationReason == .exit)
        #expect(process.terminationStatus == 1)
        #expect(process.terminationStatus != 141)
        #expect(FileManager.default.fileExists(atPath: marker.path))
        #expect(try String(contentsOf: marker, encoding: .utf8) == "shutdown\n")
    }

    private func runProcess(_ executable: URL, input: String) throws -> (status: Int32, stdout: String, stderr: String) {
        let process = Process()
        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = executable
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        stdin.fileHandleForWriting.write(Data(input.utf8))
        stdin.fileHandleForWriting.closeFile()
        process.waitUntilExit()
        return (
            process.terminationStatus,
            String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self),
            String(decoding: stderr.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        )
    }

    private func buildFixture(mainSource: String? = nil) throws -> URL {
        let root = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("surfaceloom-host-fixture-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let protocolSources = try swiftSources(root.appendingPathComponent("Sources/SurfaceLoomNativeProtocol"))
        let hostSources = try swiftSources(root.appendingPathComponent("Sources/SurfaceLoomMacOSHost"))
        try compile(protocolSources + [
            "-swift-version", "5", "-emit-module", "-emit-library", "-module-name", "SurfaceLoomNativeProtocol",
            "-emit-module-path", directory.appendingPathComponent("SurfaceLoomNativeProtocol.swiftmodule").path,
            "-o", directory.appendingPathComponent("libSurfaceLoomNativeProtocol.dylib").path,
        ])
        try compile(hostSources + [
            "-swift-version", "5", "-emit-module", "-emit-library", "-module-name", "SurfaceLoomMacOSHost",
            "-I", directory.path, "-L", directory.path, "-lSurfaceLoomNativeProtocol",
            "-emit-module-path", directory.appendingPathComponent("SurfaceLoomMacOSHost.swiftmodule").path,
            "-o", directory.appendingPathComponent("libSurfaceLoomMacOSHost.dylib").path,
        ])
        let main = directory.appendingPathComponent("main.swift")
        let source = mainSource
            ?? "import Darwin\nimport SurfaceLoomMacOSHost\nexit(NativeStdioHost().run())\n"
        try Data(source.utf8).write(to: main)
        let executable = directory.appendingPathComponent("surfaceloom-macos-host")
        try compile([
            main.path, "-swift-version", "5", "-I", directory.path, "-L", directory.path,
            "-lSurfaceLoomMacOSHost", "-lSurfaceLoomNativeProtocol",
            "-Xlinker", "-rpath", "-Xlinker", directory.path, "-o", executable.path,
        ])
        return executable
    }

    private func swiftSources(_ directory: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }.map(\.path).sorted()
    }

    private func compile(_ arguments: [String]) throws {
        let process = Process()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/swiftc")
        process.arguments = arguments
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let output = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            throw NSError(domain: "NativeHostFixtureCompiler", code: Int(process.terminationStatus),
                          userInfo: [NSLocalizedDescriptionKey: output])
        }
    }
}
