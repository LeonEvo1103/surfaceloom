import Foundation
import Testing
@testable import SurfaceLoomNativeProtocol

@Suite("Native v1 framing")
struct NativeFramingTests {
    @Test("LF, CRLF, and complete EOF use exact delimiter accounting")
    func delimiters() throws {
        let line = handshake(id: "one")
        let reader = NativeFrameReader()
        var frames: [NativeWireFrame] = []
        for byte in Data((line + "\r\n" + line + "\n" + line).utf8) {
            if let frame = try reader.append(byte, receivedUptimeNanoseconds: 10) { frames.append(frame) }
        }
        if let frame = try reader.finish(receivedUptimeNanoseconds: 20) { frames.append(frame) }
        #expect(frames.map(\.delimiterBytes) == [2, 1, 1])
        #expect(frames.map(\.receivedUptimeNanoseconds) == [10, 10, 20])
        for frame in frames {
            guard case .request = try NativeWireCodec.decode(frame) else {
                Issue.record("Expected request")
                return
            }
        }
    }

    @Test("Frame cap is enforced before fatal UTF-8 decoding")
    func frameLimitPrecedesUTF8() throws {
        let reader = NativeFrameReader()
        for _ in 0..<(NativeProtocolV1.maxMessageBytes - 1) { _ = try reader.append(0xFF) }
        expectProtocolError("message_too_large") { _ = try reader.append(0xFF) }

        let exact = NativeWireFrame(
            bytes: Data(repeating: 0xFF, count: NativeProtocolV1.maxMessageBytes - 1),
            delimiterBytes: 1,
            receivedUptimeNanoseconds: 0
        )
        expectProtocolError("invalid_utf8") { _ = try NativeWireCodec.decode(exact) }
    }

    @Test("BOM is not stripped from first or later frames")
    func bomIsNotStripped() throws {
        let bom = "\u{FEFF}"
        for text in [bom + handshake(id: "first"), handshake(id: "ok") + "\n" + bom + handshake(id: "second")] {
            let reader = NativeFrameReader()
            var frames: [NativeWireFrame] = []
            for byte in Data(text.utf8) {
                if let frame = try reader.append(byte) { frames.append(frame) }
            }
            if let frame = try reader.finish() { frames.append(frame) }
            expectProtocolError("invalid_json") { _ = try NativeWireCodec.decode(frames.last!) }
        }
    }

    @Test("Decoded duplicate keys fail at every nesting level")
    func duplicateKeys() {
        let top = handshake(id: "original").replacingOccurrences(
            of: "\"id\":\"original\"", with: "\"id\":\"original\",\"\\u0069d\":\"shadow\""
        )
        let nested = handshake(id: "nested").replacingOccurrences(
            of: "\"payload\":{}", with: "\"payload\":{\"name\":1,\"n\\u0061me\":2}"
        )
        for text in [top, nested] {
            expectProtocolError("invalid_json", messageContains: "duplicate") { _ = try decode(text) }
        }
    }

    @Test("Payload depth and finite-number boundary is explicit")
    func payloadSemanticBoundary() throws {
        for count in [30, 31] {
            let request = try decode(handshake(id: "depth-\(count)", payload: nestedPayload(arrayCount: count)))
            let encoded = try NativeWireCodec.encode(request)
            #expect(encoded.last == 0x0A)
            _ = try NativeWireCodec.decode(NativeWireFrame(
                bytes: Data(encoded.dropLast()), delimiterBytes: 1, receivedUptimeNanoseconds: 0
            ))
        }
        expectProtocolError("invalid_message") {
            _ = try decode(handshake(id: "depth-bad", payload: nestedPayload(arrayCount: 32)))
        }
        expectProtocolError("invalid_message") {
            _ = try decode(handshake(id: "infinite", payload: "{\"value\":1e309}"))
        }

        let result = nestedArrayValue(count: 31)
        let response = NativeWireMessage.response(NativeResponse(id: "response-depth", result: result))
        let encodedResponse = try NativeWireCodec.encode(response)
        _ = try NativeWireCodec.decode(NativeWireFrame(
            bytes: Data(encodedResponse.dropLast()), delimiterBytes: 1, receivedUptimeNanoseconds: 0
        ))
        expectProtocolError("invalid_message") {
            _ = try NativeWireCodec.encode(.response(NativeResponse(
                id: "response-too-deep", result: nestedArrayValue(count: 33)
            )))
        }
    }

    @Test("Canonical-equivalent distinct keys survive while lone surrogates fail")
    func exactKeyIdentityAndSurrogates() throws {
        let payload = "{\"\\u00E9\":1,\"e\\u0301\":2}"
        guard case let .request(request) = try decode(handshake(id: "keys", payload: payload)) else {
            Issue.record("Expected request")
            return
        }
        #expect(request.call.payload.count == 2)
        #expect(request.call.payload["é"] == .number(1))
        #expect(request.call.payload["e\u{0301}"] == .number(2))
        let encoded = try NativeWireCodec.encode(.request(request))
        guard case let .request(roundTrip) = try NativeWireCodec.decode(NativeWireFrame(
            bytes: Data(encoded.dropLast()), delimiterBytes: 1, receivedUptimeNanoseconds: 0
        )) else {
            Issue.record("Expected round-trip request")
            return
        }
        #expect(roundTrip.call.payload.count == 2)
        #expect(roundTrip.call.payload["é"] == .number(1))
        #expect(roundTrip.call.payload["e\u{0301}"] == .number(2))

        for invalid in ["{\"\\uD800\":1}", "{\"\\uDC00\":1}"] {
            expectProtocolError("invalid_json") { _ = try decode(handshake(id: "surrogate", payload: invalid)) }
        }
    }

    private func expectProtocolError(
        _ code: String,
        messageContains: String? = nil,
        _ operation: () throws -> Void
    ) {
        do {
            try operation()
            Issue.record("Expected NativeProtocolError \(code)")
        } catch let error as NativeProtocolError {
            #expect(error.code == code)
            if let messageContains { #expect(error.message.contains(messageContains)) }
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    private func decode(_ text: String) throws -> NativeWireMessage {
        try NativeWireCodec.decode(NativeWireFrame(bytes: Data(text.utf8), delimiterBytes: 1, receivedUptimeNanoseconds: 0))
    }

    private func handshake(id: String, payload: String = "{}") -> String {
        "{\"protocol\":\"surfaceloom.native\",\"version\":\"1.0\",\"type\":\"request\"," +
        "\"id\":\"\(id)\",\"deadline\":{\"timeoutMs\":1000},\"call\":{" +
        "\"name\":\"host.handshake\",\"intent\":\"observe\",\"scope\":{\"kind\":\"bootstrap\"}," +
        "\"payload\":\(payload)}}"
    }

    private func nestedPayload(arrayCount: Int) -> String {
        "{\"value\":" + String(repeating: "[", count: arrayCount) + "null" +
        String(repeating: "]", count: arrayCount) + "}"
    }

    private func nestedArrayValue(count: Int) -> NativeJSONValue {
        (0..<count).reduce(.null) { value, _ in .array([value]) }
    }
}
