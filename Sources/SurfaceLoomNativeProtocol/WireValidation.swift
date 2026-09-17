import Foundation

enum WireValidation {
    static func object(
        _ value: NativeJSONValue,
        label: String,
        allowed: Set<String>
    ) throws -> NativeJSONObject {
        guard case let .object(result) = value else { throw invalid("\(label) must be an object.") }
        if result.keys.contains(where: { !allowed.contains($0) }) {
            throw invalid("\(label) contains an unknown field.")
        }
        return result
    }

    static func required(
        _ input: NativeJSONObject,
        _ key: String,
        label: String
    ) throws -> NativeJSONValue {
        guard let value = input[key] else { throw invalid("\(label).\(key) is required.") }
        return value
    }

    static func text(_ value: NativeJSONValue, label: String, maximum: Int = 128) throws -> String {
        guard case let .string(result) = value,
              !result.isEmpty,
              result.lengthOfBytes(using: .utf8) <= maximum,
              !result.contains("\0"), !result.contains("\r"), !result.contains("\n") else {
            throw invalid("\(label) is not a bounded single-line string.")
        }
        return result
    }

    static func identifier(_ value: NativeJSONValue, label: String) throws -> String {
        let result = try text(value, label: label)
        let bytes = Array(result.utf8)
        guard let first = bytes.first, isASCIIAlphaNumeric(first),
              bytes.dropFirst().allSatisfy({ isASCIIAlphaNumeric($0) || [46, 95, 58, 45].contains($0) }) else {
            throw invalid("\(label) is not a wire identifier.")
        }
        return result
    }

    static func integer(
        _ value: NativeJSONValue,
        label: String,
        minimum: Int,
        maximum: Int
    ) throws -> Int {
        guard case let .number(number) = value,
              number.isFinite, number.rounded() == number,
              abs(number) <= 9_007_199_254_740_991,
              number >= Double(minimum), number <= Double(maximum) else {
            throw invalid("\(label) must be an integer between \(minimum) and \(maximum).")
        }
        return Int(number)
    }

    static func methodName(_ value: NativeJSONValue, label: String) throws -> String {
        let name = try text(value, label: label)
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count >= 2,
              validMethodPart(parts[0], initialLowercase: true),
              parts.dropFirst().allSatisfy({ validMethodPart($0, initialLowercase: false) }) else {
            throw invalid("\(label) must be namespaced.")
        }
        return name
    }

    static func invalid(_ message: String, requestID: String? = nil) -> NativeProtocolError {
        NativeProtocolError(
            code: "invalid_message",
            category: .invalidRequest,
            message: message,
            requestID: requestID
        )
    }

    private static func validMethodPart(_ part: Substring, initialLowercase: Bool) -> Bool {
        let bytes = Array(part.utf8)
        guard let first = bytes.first else { return false }
        let firstValid = initialLowercase ? (97...122).contains(first) : isASCIIAlpha(first)
        return firstValid && bytes.dropFirst().allSatisfy { isASCIIAlphaNumeric($0) || $0 == 45 }
    }

    private static func isASCIIAlpha(_ byte: UInt8) -> Bool {
        (65...90).contains(byte) || (97...122).contains(byte)
    }

    private static func isASCIIAlphaNumeric(_ byte: UInt8) -> Bool {
        isASCIIAlpha(byte) || (48...57).contains(byte)
    }
}
