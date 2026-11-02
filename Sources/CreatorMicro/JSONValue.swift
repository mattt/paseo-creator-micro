import Foundation

/// A JSON value that can cross isolation boundaries.
///
/// The keypad's JSON-RPC messages carry arbitrary JSON.
/// `JSONValue` holds that JSON as a value type,
/// so that replies and notifications are `Sendable`.
public enum JSONValue: Sendable, Hashable {
    /// The JSON `null` value.
    case null
    /// A Boolean value.
    case bool(Bool)
    /// A number. Integral values encode without a fractional part.
    case number(Double)
    /// A string.
    case string(String)
    /// An ordered array of values.
    case array([JSONValue])
    /// An object, keyed by string.
    case object([String: JSONValue])

    /// Parses a JSON value from UTF-8 data.
    ///
    /// - Parameter data: The JSON text, in UTF-8.
    /// - Throws: `DecodingError` if the data is not valid JSON.
    public init(parsing data: Data) throws {
        self = try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// Returns the compact JSON encoding of the value, with sorted keys.
    ///
    /// - Returns: The JSON text, in UTF-8.
    public func encoded() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Encoding a JSONValue cannot fail: every case maps to a JSON value,
        // and non-finite numbers encode as null.
        return (try? encoder.encode(self)) ?? Data("null".utf8)
    }

    /// The compact JSON text of the value, with sorted keys.
    public var jsonString: String {
        String(decoding: encoded(), as: UTF8.self)
    }

    /// The value as a `Bool`, or `nil` if it is not a Boolean.
    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    /// The value as a `Double`, or `nil` if it is not a number.
    public var doubleValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// The value as an `Int`, or `nil` if it is not an integral number.
    public var intValue: Int? {
        guard case .number(let value) = self, value.rounded() == value,
            value >= Double(Int.min), value < Double(Int.max)
        else { return nil }
        return Int(value)
    }

    /// The value as a `String`, or `nil` if it is not a string.
    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// The value as an array, or `nil` if it is not an array.
    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    /// The value as an object, or `nil` if it is not an object.
    public var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    /// Returns the member with the given key, or `nil` if the value is not an object or has no such member.
    public subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }
}

extension JSONValue: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not a JSON value")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .number(let value):
            if !value.isFinite {
                try container.encodeNil()
            } else if let integer = intValue {
                try container.encode(integer)
            } else {
                try container.encode(value)
            }
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }
}

extension JSONValue: ExpressibleByNilLiteral {
    public init(nilLiteral: ()) { self = .null }
}

extension JSONValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension JSONValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
}

extension JSONValue: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) { self = .number(value) }
}

extension JSONValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}

extension JSONValue: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}

extension JSONValue: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }
}

extension JSONValue: CustomStringConvertible {
    public var description: String { jsonString }
}
