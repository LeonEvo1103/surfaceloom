import Foundation
import Testing
@testable import SurfaceLoomNativeProtocol

@Suite("Native JSON wide objects")
struct NativeWideObjectTests {
    @Test("Wide objects use exact indexed lookup and deterministic encoding")
    func indexedWideObjectRoundTrip() throws {
        var entries = (0..<8_192).map { ("key-\($0)", NativeJSONValue.number(Double($0))) }
        entries.append(("é", .string("precomposed")))
        entries.append(("e\u{0301}", .string("decomposed")))
        entries.append(("key-0", .string("overridden")))
        let object = NativeJSONObject(entries)

        #expect(object.count == 8_194)
        #expect(object["key-0"] == .string("overridden"))
        #expect(object["key-8191"] == .number(8_191))
        #expect(object["é"] == .string("precomposed"))
        #expect(object["e\u{0301}"] == .string("decomposed"))

        let request = NativeWireMessage.request(NativeRequest(
            id: "wide-object",
            timeoutMilliseconds: 10_000,
            call: NativeCall(name: "test.observe", intent: .observe,
                             scope: .host(hostInstanceID: "host-wide"), payload: object)
        ))
        let first = try NativeWireCodec.encode(request)
        let second = try NativeWireCodec.encode(request)
        #expect(first == second)
        guard case let .request(roundTrip) = try NativeWireCodec.decode(NativeWireFrame(
            bytes: Data(first.dropLast()), delimiterBytes: 1, receivedUptimeNanoseconds: 0
        )) else {
            Issue.record("Expected wide request round-trip")
            return
        }
        #expect(roundTrip.call.payload.count == object.count)
        #expect(roundTrip.call.payload["key-8191"] == .number(8_191))
        #expect(roundTrip.call.payload["é"] == .string("precomposed"))
        #expect(roundTrip.call.payload["e\u{0301}"] == .string("decomposed"))
    }
}
