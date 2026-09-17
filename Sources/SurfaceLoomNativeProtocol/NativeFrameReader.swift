import Foundation

public struct NativeWireFrame: Equatable, Sendable {
    public let bytes: Data
    public let delimiterBytes: Int
    public let receivedUptimeNanoseconds: UInt64

    public init(bytes: Data, delimiterBytes: Int, receivedUptimeNanoseconds: UInt64) {
        self.bytes = bytes
        self.delimiterBytes = delimiterBytes
        self.receivedUptimeNanoseconds = receivedUptimeNanoseconds
    }
}

public final class NativeFrameReader {
    private var buffer: [UInt8] = []
    private var finished = false

    public init() {
        buffer.reserveCapacity(4_096)
    }

    public func append(
        _ byte: UInt8,
        receivedUptimeNanoseconds: @autoclosure () -> UInt64 = DispatchTime.now().uptimeNanoseconds
    ) throws -> NativeWireFrame? {
        guard !finished else {
            throw NativeProtocolError(code: "invalid_frame", message: "Frame reader is already finished.")
        }
        if byte == 0x0A {
            let isCRLF = buffer.last == 0x0D
            let content = isCRLF ? buffer.dropLast() : buffer[...]
            let frame = NativeWireFrame(
                bytes: Data(content),
                delimiterBytes: isCRLF ? 2 : 1,
                receivedUptimeNanoseconds: receivedUptimeNanoseconds()
            )
            buffer.removeAll(keepingCapacity: true)
            return frame
        }
        guard buffer.count < NativeProtocolV1.maxMessageBytes - 1 else {
            finished = true
            throw NativeProtocolError(
                code: "message_too_large",
                message: "Wire frame exceeds the protocol byte limit."
            )
        }
        buffer.append(byte)
        return nil
    }

    public func finish(
        receivedUptimeNanoseconds: @autoclosure () -> UInt64 = DispatchTime.now().uptimeNanoseconds
    ) throws -> NativeWireFrame? {
        guard !finished else { return nil }
        finished = true
        guard !buffer.isEmpty else { return nil }
        return NativeWireFrame(
            bytes: Data(buffer),
            delimiterBytes: 1,
            receivedUptimeNanoseconds: receivedUptimeNanoseconds()
        )
    }
}
