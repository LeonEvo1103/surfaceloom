import Foundation

enum NativeJSONWriter {
    static func encode(_ value: NativeJSONValue) throws -> Data {
        // append counts raw containers independently of the scalar leaf and
        // enforces the same 64-container rule as StrictJSONParser. This walk
        // also rejects non-finite numbers before output is retained.
        try value.validateJSON(maximumDepth: 64)
        var output = ""
        try append(value, to: &output, depth: 0)
        guard let data = output.data(using: .utf8) else {
            throw NativeProtocolError(code: "invalid_message", message: "JSON output is not UTF-8.")
        }
        return data
    }

    private static func append(_ value: NativeJSONValue, to output: inout String, depth: Int) throws {
        switch value {
        case .null:
            output += "null"
        case let .bool(value):
            output += value ? "true" : "false"
        case let .number(value):
            guard value.isFinite else {
                throw NativeProtocolError(code: "invalid_message", message: "JSON numbers must be finite.")
            }
            output += String(value)
        case let .string(value):
            appendString(value, to: &output)
        case let .array(values):
            guard depth < 64 else {
                throw NativeProtocolError(code: "invalid_message", message: "JSON output exceeds the nesting limit.")
            }
            output += "["
            for (index, item) in values.enumerated() {
                if index > 0 { output += "," }
                try append(item, to: &output, depth: depth + 1)
            }
            output += "]"
        case let .object(values):
            guard depth < 64 else {
                throw NativeProtocolError(code: "invalid_message", message: "JSON output exceeds the nesting limit.")
            }
            output += "{"
            for (index, entry) in values.sortedEntries().enumerated() {
                if index > 0 { output += "," }
                appendString(entry.0, to: &output)
                output += ":"
                try append(entry.1, to: &output, depth: depth + 1)
            }
            output += "}"
        }
    }

    private static func appendString(_ value: String, to output: inout String) {
        output += "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": output += "\\\""
            case "\\": output += "\\\\"
            case "\u{0008}": output += "\\b"
            case "\u{000C}": output += "\\f"
            case "\n": output += "\\n"
            case "\r": output += "\\r"
            case "\t": output += "\\t"
            default:
                if scalar.value < 0x20 {
                    output += String(format: "\\u%04X", scalar.value)
                } else {
                    output.unicodeScalars.append(scalar)
                }
            }
        }
        output += "\""
    }
}
