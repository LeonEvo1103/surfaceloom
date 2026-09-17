import Foundation

public indirect enum NativeJSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([NativeJSONValue])
    case object(NativeJSONObject)

    public var objectValue: NativeJSONObject? {
        guard case let .object(value) = self else { return nil }
        return value
    }
}

public struct NativeJSONObject: Equatable, Sendable, ExpressibleByDictionaryLiteral {
    struct Entry: Equatable, Sendable {
        let key: ExactJSONKey
        var value: NativeJSONValue
    }

    private var entries: [Entry]
    private var indexByKey: [ExactJSONKey: Int]

    public init(dictionaryLiteral elements: (String, NativeJSONValue)...) {
        self.init(elements)
    }

    public init(_ elements: [(String, NativeJSONValue)] = []) {
        entries = []
        indexByKey = [:]
        entries.reserveCapacity(elements.count)
        indexByKey.reserveCapacity(elements.count)
        for (key, value) in elements {
            let exactKey = ExactJSONKey(key)
            if let index = indexByKey[exactKey] {
                entries[index].value = value
            } else {
                indexByKey[exactKey] = entries.count
                entries.append(Entry(key: exactKey, value: value))
            }
        }
    }

    public var count: Int { entries.count }
    public var isEmpty: Bool { entries.isEmpty }
    public var keys: [String] { entries.map { $0.key.value } }
    public var values: [NativeJSONValue] { entries.map(\.value) }

    public subscript(key: String) -> NativeJSONValue? {
        get { indexByKey[ExactJSONKey(key)].map { entries[$0].value } }
        set {
            let exactKey = ExactJSONKey(key)
            if let index = indexByKey[exactKey] {
                if let newValue {
                    entries[index].value = newValue
                } else {
                    entries.remove(at: index)
                    indexByKey.removeValue(forKey: exactKey)
                    for movedIndex in index..<entries.count {
                        indexByKey[entries[movedIndex].key] = movedIndex
                    }
                }
            } else if let newValue {
                indexByKey[exactKey] = entries.count
                entries.append(Entry(key: exactKey, value: newValue))
            }
        }
    }

    func sortedEntries() -> [(String, NativeJSONValue)] {
        entries.sorted { $0.key.bytes.lexicographicallyPrecedes($1.key.bytes) }
            .map { ($0.key.value, $0.value) }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        let left = lhs.entries.sorted { $0.key.bytes.lexicographicallyPrecedes($1.key.bytes) }
        let right = rhs.entries.sorted { $0.key.bytes.lexicographicallyPrecedes($1.key.bytes) }
        return left == right
    }
}

struct ExactJSONKey: Equatable, Hashable, Sendable {
    let value: String
    let bytes: [UInt8]

    init(_ value: String) {
        self.value = value
        bytes = Array(value.utf8)
    }

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.bytes == rhs.bytes }

    func hash(into hasher: inout Hasher) {
        hasher.combine(bytes.count)
        bytes.forEach { hasher.combine($0) }
    }
}

extension NativeJSONValue {
    func validateJSON(depth: Int = 0, maximumDepth: Int) throws {
        guard depth <= maximumDepth else {
            throw NativeProtocolError(code: "invalid_message", category: .invalidRequest,
                                      message: "JSON value exceeds the nesting limit.")
        }
        switch self {
        case let .number(value) where !value.isFinite:
            throw NativeProtocolError(code: "invalid_message", category: .invalidRequest,
                                      message: "JSON numbers must be finite.")
        case let .array(values):
            try values.forEach { try $0.validateJSON(depth: depth + 1, maximumDepth: maximumDepth) }
        case let .object(values):
            try values.values.forEach { try $0.validateJSON(depth: depth + 1, maximumDepth: maximumDepth) }
        default:
            break
        }
    }
}
