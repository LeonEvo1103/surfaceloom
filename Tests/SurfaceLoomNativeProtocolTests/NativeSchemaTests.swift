import Foundation
import Testing
@testable import SurfaceLoomNativeProtocol

@Suite("Native v1 schema")
struct NativeSchemaTests {
    @Test("Header fields, scope, intent, id, and deadline are strict")
    func strictSchema() throws {
        let valid = request()
        _ = try decode(valid)
        expectInvalid(valid.replacingOccurrences(of: "\"version\":\"1.0\"", with: "\"version\":\"1.1\""), code: "unsupported_version")
        expectInvalid(valid.replacingOccurrences(of: "\"id\":\"request-1\"", with: "\"id\":\"bad id\""), code: "invalid_message")
        expectInvalid(valid.replacingOccurrences(of: "\"timeoutMs\":1000", with: "\"timeoutMs\":120001"), code: "invalid_message")
        expectInvalid(valid.replacingOccurrences(of: "\"intent\":\"observe\"", with: "\"intent\":\"mutate\""), code: "invalid_message")
        expectInvalid(valid.replacingOccurrences(of: "\"scope\":{\"kind\":\"bootstrap\"}", with: "\"scope\":{\"kind\":\"host\",\"hostInstanceId\":\"h\"}"), code: "invalid_message")
        expectInvalid(String(valid.dropLast()) + ",\"legacy\":true}", code: "invalid_message")
    }

    @Test("Encoding produces one bounded LF frame and round-trips")
    func encoding() throws {
        let decoded = try decode(request())
        let encoded = try NativeWireCodec.encode(decoded)
        #expect(encoded.last == 0x0A)
        #expect(encoded.count <= NativeProtocolV1.maxMessageBytes)
        let body = encoded.dropLast()
        #expect(!body.contains(0x0A))
        #expect(try NativeWireCodec.decode(NativeWireFrame(
            bytes: Data(body), delimiterBytes: 1, receivedUptimeNanoseconds: 1
        )) == decoded)
    }

    @Test("Shared golden vector inventory decodes consistently")
    func sharedGoldenVectors() throws {
        let root = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = root.appendingPathComponent("packages/native/vectors/v1")
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasSuffix(".vector.json") }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        #expect(files.map(\.lastPathComponent) == [
            "01-handshake-request.vector.json", "02-handshake-response.vector.json",
            "03-session-launch.vector.json", "04-session-launch-response.vector.json",
            "05-handle-observe.vector.json", "06-action-not-executed.vector.json",
            "07-action-unknown.vector.json", "08-cancel.vector.json",
            "09-windows-02-not-shared.vector.json", "10-unsupported-version.vector.json",
            "11-duplicate-json-key.vector.json", "12-payload-depth-32.vector.json",
            "13-payload-depth-33.vector.json", "14-result-depth-32.vector.json",
            "15-result-depth-33.vector.json", "16-details-depth-32.vector.json",
            "17-details-depth-33.vector.json", "18-canonical-equivalent-keys.vector.json",
            "19-escaped-high-surrogate.vector.json", "20-escaped-low-surrogate.vector.json",
            "21-raw-array-depth-64-empty.vector.json", "22-raw-array-depth-64-value.vector.json",
            "23-raw-array-depth-65-empty.vector.json", "24-raw-array-depth-65-value.vector.json",
            "25-raw-object-depth-64-empty.vector.json", "26-raw-object-depth-64-value.vector.json",
            "27-raw-object-depth-65-empty.vector.json", "28-raw-object-depth-65-value.vector.json",
        ])
        for file in files {
            let outer = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
            let wireData: Data
            if let wire = outer["wire"] as? String { wireData = Data(wire.utf8) }
            else { wireData = try JSONSerialization.data(withJSONObject: outer["message"]!) }
            let frame = NativeWireFrame(bytes: wireData, delimiterBytes: 1, receivedUptimeNanoseconds: 0)
            if let rawValid = outer["rawValid"] as? Bool {
                #expect(outer["rawContainerDepth"] as? Int == (rawValid ? 64 : 65))
                if rawValid { _ = try NativeWireCodec.parseFrame(frame) }
                else { expectProtocolError("invalid_json") { _ = try NativeWireCodec.parseFrame(frame) } }
                continue
            }
            if outer["valid"] as! Bool {
                let message = try NativeWireCodec.decode(frame)
                if let expected = outer["expectedPayloadKeyUtf8Hex"] as? [String] {
                    guard case let .request(request) = message else {
                        Issue.record("Expected request for exact-key vector")
                        continue
                    }
                    #expect(request.call.payload.keys.map(utf8Hex) == expected)
                }
            } else {
                expectProtocolError(outer["errorCode"] as! String) { _ = try NativeWireCodec.decode(frame) }
            }
        }
    }

    @Test("Host descriptor and request-response correlation remain strict")
    func semanticValidation() throws {
        let host = NativeHostDescriptor(
            hostInstanceID: "host-1",
            platform: "macos",
            backend: "stdio-shell",
            methods: [NativeMethodDescriptor(name: "host.handshake", intent: .observe, scopeKinds: ["bootstrap"])]
        )
        #expect(try NativeProtocolSemantics.decodeHostDescriptor(host.jsonValue) == host)
        guard case let .object(fields) = host.jsonValue else { return }
        var extra = fields
        extra["architecture"] = .string("arm64")
        expectProtocolError("invalid_message") {
            _ = try NativeProtocolSemantics.decodeHostDescriptor(.object(extra))
        }

        let request = NativeRequest(
            id: "request-action",
            timeoutMilliseconds: 1_000,
            call: NativeCall(name: "test.action", intent: .mutate,
                             scope: .host(hostInstanceID: "host-1"), payload: [:],
                             operationID: "operation-action")
        )
        let unknownSuccess = NativeResponse(
            id: request.id,
            result: .object([:]),
            operation: NativeOperationReceipt(operationID: "operation-action", outcome: .unknown)
        )
        expectProtocolError("correlation_mismatch") {
            try NativeProtocolSemantics.validateResponse(unknownSuccess, for: request)
        }
    }

    @Test("Emergency failure encoding is bounded and input-independent")
    func emergencyFailureEncoding() {
        let secret = "/Users/example/private-token"
        let frame = NativeWireCodec.encodeFailureOrEmergency(
            id: "invalid id\n\(secret)",
            code: String(repeating: "x", count: 4_000),
            category: .internal,
            message: secret
        )
        let text = String(decoding: frame, as: UTF8.self)
        #expect(frame.last == 0x0A)
        #expect(frame.count <= NativeProtocolV1.maxMessageBytes)
        #expect(!text.contains(secret))
        #expect(text.contains("\"id\":\"invalid\""))
    }

    private func expectInvalid(_ text: String, code: String) {
        expectProtocolError(code) { _ = try decode(text) }
    }

    private func expectProtocolError(_ code: String, _ operation: () throws -> Void) {
        do { try operation(); Issue.record("Expected NativeProtocolError \(code)") }
        catch let error as NativeProtocolError { #expect(error.code == code) }
        catch { Issue.record("Unexpected error: \(error)") }
    }

    private func decode(_ text: String) throws -> NativeWireMessage {
        try NativeWireCodec.decode(NativeWireFrame(bytes: Data(text.utf8), delimiterBytes: 1, receivedUptimeNanoseconds: 0))
    }

    private func utf8Hex(_ value: String) -> String {
        value.utf8.map { String(format: "%02x", $0) }.joined()
    }

    private func request() -> String {
        "{\"protocol\":\"surfaceloom.native\",\"version\":\"1.0\",\"type\":\"request\"," +
        "\"id\":\"request-1\",\"deadline\":{\"timeoutMs\":1000},\"call\":{" +
        "\"name\":\"host.handshake\",\"intent\":\"observe\",\"scope\":{\"kind\":\"bootstrap\"},\"payload\":{}}}"
    }
}
