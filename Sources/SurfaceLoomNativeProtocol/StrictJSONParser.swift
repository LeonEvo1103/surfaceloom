import Foundation

enum StrictJSONParser {
    static func parse(_ text: String) throws -> NativeJSONValue {
        var parser = Parser(Array(text.unicodeScalars))
        let value = try parser.parseValue(depth: 0)
        parser.skipWhitespace()
        guard parser.isAtEnd else { throw parser.invalidJSON() }
        return value
    }

    private struct Parser {
        let scalars: [Unicode.Scalar]
        var index = 0

        init(_ scalars: [Unicode.Scalar]) {
            self.scalars = scalars
        }

        var isAtEnd: Bool { index == scalars.count }
        var current: Unicode.Scalar? { isAtEnd ? nil : scalars[index] }

        mutating func parseValue(depth: Int) throws -> NativeJSONValue {
            skipWhitespace()
            switch current {
            // depth counts open containers, not the scalar leaf. The 64th
            // container may be empty or contain a scalar; a 65th may not open.
            case "{":
                guard depth < 64 else { throw invalidJSON("Wire frame exceeds the JSON nesting limit.") }
                return try parseObject(depth: depth + 1)
            case "[":
                guard depth < 64 else { throw invalidJSON("Wire frame exceeds the JSON nesting limit.") }
                return try parseArray(depth: depth + 1)
            case "\"": return .string(try parseString())
            case "t": try consume("true"); return .bool(true)
            case "f": try consume("false"); return .bool(false)
            case "n": try consume("null"); return .null
            case "-": return try parseNumber()
            default:
                if let scalar = current, (48...57).contains(scalar.value) { return try parseNumber() }
                throw invalidJSON()
            }
        }

        mutating func parseObject(depth: Int) throws -> NativeJSONValue {
            index += 1
            skipWhitespace()
            if current == "}" {
                index += 1
                return .object([:])
            }
            var entries: [(String, NativeJSONValue)] = []
            var keys = Set<ExactJSONKey>()
            while true {
                guard current == "\"" else { throw invalidJSON() }
                let key = try parseString()
                guard keys.insert(ExactJSONKey(key)).inserted else {
                    throw invalidJSON("Wire frame contains a duplicate object key.")
                }
                skipWhitespace()
                guard current == ":" else { throw invalidJSON() }
                index += 1
                entries.append((key, try parseValue(depth: depth)))
                skipWhitespace()
                if current == "}" {
                    index += 1
                    return .object(NativeJSONObject(entries))
                }
                guard current == "," else { throw invalidJSON() }
                index += 1
                skipWhitespace()
            }
        }

        mutating func parseArray(depth: Int) throws -> NativeJSONValue {
            index += 1
            skipWhitespace()
            if current == "]" {
                index += 1
                return .array([])
            }
            var values: [NativeJSONValue] = []
            while true {
                values.append(try parseValue(depth: depth))
                skipWhitespace()
                if current == "]" {
                    index += 1
                    return .array(values)
                }
                guard current == "," else { throw invalidJSON() }
                index += 1
                skipWhitespace()
            }
        }

        mutating func parseString() throws -> String {
            index += 1
            var result = String.UnicodeScalarView()
            while let scalar = current {
                index += 1
                if scalar == "\"" { return String(result) }
                if scalar.value < 0x20 { throw invalidJSON() }
                if scalar != "\\" {
                    result.append(scalar)
                    continue
                }
                guard let escape = current else { throw invalidJSON() }
                index += 1
                switch escape {
                case "\"", "\\", "/": result.append(escape)
                case "b": result.append("\u{0008}")
                case "f": result.append("\u{000C}")
                case "n": result.append("\n")
                case "r": result.append("\r")
                case "t": result.append("\t")
                case "u": try appendUnicodeEscape(to: &result)
                default: throw invalidJSON()
                }
            }
            throw invalidJSON()
        }

        mutating func appendUnicodeEscape(to result: inout String.UnicodeScalarView) throws {
            let first = try readHexQuad()
            if (0xD800...0xDBFF).contains(first) {
                guard current == "\\", index + 1 < scalars.count, scalars[index + 1] == "u" else {
                    throw invalidJSON()
                }
                index += 2
                let second = try readHexQuad()
                guard (0xDC00...0xDFFF).contains(second) else { throw invalidJSON() }
                let value = 0x10000 + ((first - 0xD800) << 10) + second - 0xDC00
                guard let scalar = Unicode.Scalar(value) else { throw invalidJSON() }
                result.append(scalar)
            } else {
                guard !(0xDC00...0xDFFF).contains(first), let scalar = Unicode.Scalar(first) else {
                    throw invalidJSON()
                }
                result.append(scalar)
            }
        }

        mutating func readHexQuad() throws -> UInt32 {
            guard index + 4 <= scalars.count else { throw invalidJSON() }
            var value: UInt32 = 0
            for _ in 0..<4 {
                guard let digit = scalars[index].hexDigitValue else { throw invalidJSON() }
                value = value * 16 + UInt32(digit)
                index += 1
            }
            return value
        }

        mutating func parseNumber() throws -> NativeJSONValue {
            let start = index
            if current == "-" { index += 1 }
            guard let digit = current else { throw invalidJSON() }
            if digit == "0" {
                index += 1
                if let next = current, ("0"..."9").contains(next) { throw invalidJSON() }
            } else if ("1"..."9").contains(digit) {
                consumeDigits()
            } else {
                throw invalidJSON()
            }
            if current == "." {
                index += 1
                guard let next = current, ("0"..."9").contains(next) else { throw invalidJSON() }
                consumeDigits()
            }
            if current == "e" || current == "E" {
                index += 1
                if current == "+" || current == "-" { index += 1 }
                guard let next = current, ("0"..."9").contains(next) else { throw invalidJSON() }
                consumeDigits()
            }
            var raw = String.UnicodeScalarView()
            scalars[start..<index].forEach { raw.append($0) }
            guard let value = Double(String(raw)) else { throw invalidJSON() }
            return .number(value)
        }

        mutating func consumeDigits() {
            while let scalar = current, ("0"..."9").contains(scalar) { index += 1 }
        }

        mutating func consume(_ expected: String) throws {
            for scalar in expected.unicodeScalars {
                guard current == scalar else { throw invalidJSON() }
                index += 1
            }
        }

        mutating func skipWhitespace() {
            while let scalar = current, scalar == " " || scalar == "\t" || scalar == "\n" || scalar == "\r" {
                index += 1
            }
        }

        func invalidJSON(_ message: String = "Wire frame is not valid JSON.") -> NativeProtocolError {
            NativeProtocolError(code: "invalid_json", message: message)
        }
    }
}

private extension Unicode.Scalar {
    var hexDigitValue: Int? {
        switch value {
        case 48...57: return Int(value - 48)
        case 65...70: return Int(value - 55)
        case 97...102: return Int(value - 87)
        default: return nil
        }
    }
}
