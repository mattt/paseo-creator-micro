/// A 24-bit RGB color.
///
/// The `Codable` form is a string such as `"#FF2D2D"`;
/// the firmware takes the packed integer `0xRRGGBB`.
public struct LightColor: Sendable, Hashable {
    /// The red component.
    public var red: UInt8
    /// The green component.
    public var green: UInt8
    /// The blue component.
    public var blue: UInt8

    /// Creates a color from its components.
    ///
    /// - Parameters:
    ///   - red: The red component.
    ///   - green: The green component.
    ///   - blue: The blue component.
    public init(red: UInt8, green: UInt8, blue: UInt8) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    /// Creates a color from a packed `0xRRGGBB` integer.
    ///
    /// - Parameter packed: The color; bits above the low 24 are ignored.
    public init(packed: Int) {
        red = UInt8((packed >> 16) & 0xFF)
        green = UInt8((packed >> 8) & 0xFF)
        blue = UInt8(packed & 0xFF)
    }

    /// Parses a hexadecimal color: `#RRGGBB`, `RRGGBB`, `#RGB`, or `RGB`.
    ///
    /// - Parameter hex: The color text.
    /// - Returns: The color, or `nil` if the text is not a hexadecimal color.
    public init?(hex: String) {
        var digits = Substring(hex.trimmingPrefix("#"))
        if digits.count == 3 {
            digits = Substring(digits.flatMap { [$0, $0] })
        }
        guard digits.count == 6, digits.allSatisfy(\.isHexDigit), let packed = Int(digits, radix: 16) else {
            return nil
        }
        self.init(packed: packed)
    }

    /// The packed `0xRRGGBB` integer that the firmware takes.
    public var packed: Int {
        Int(red) << 16 | Int(green) << 8 | Int(blue)
    }

    /// The color as `#RRGGBB`, in uppercase.
    public var hex: String {
        let digits = String(packed, radix: 16, uppercase: true)
        return "#" + String(repeating: "0", count: 6 - digits.count) + digits
    }

    /// Black, which shows as no light.
    public static let black = LightColor(packed: 0x000000)
    /// White.
    public static let white = LightColor(packed: 0xFFFFFF)
}

extension LightColor: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let packed = try? container.decode(Int.self) {
            self.init(packed: packed)
            return
        }
        let text = try container.decode(String.self)
        guard let color = LightColor(hex: text) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Expected a color such as \"#FF2D2D\", not \"\(text)\""
            )
        }
        self = color
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(hex)
    }
}

extension LightColor: CustomStringConvertible {
    public var description: String { hex }
}

/// A lighting animation, by firmware index.
///
/// The `Codable` form is the name, such as `"breathing"`.
public enum LightEffect: Int, Sendable, Hashable, CaseIterable {
    /// No light.
    case off = 0
    /// A steady color.
    case solid = 1
    /// A light that runs around the zone.
    case snake = 2
    /// Cycling colors.
    case rainbow = 3
    /// A slow pulse.
    case breathing = 4
    /// A color gradient.
    case gradient = 5
    /// A gentle pulse.
    case shallowBreathing = 6

    /// The effect's name in the bridge protocol and the MCP tools.
    public var name: String {
        switch self {
        case .off: "off"
        case .solid: "solid"
        case .snake: "snake"
        case .rainbow: "rainbow"
        case .breathing: "breathing"
        case .gradient: "gradient"
        case .shallowBreathing: "shallowBreathing"
        }
    }

    /// Finds an effect by its name.
    ///
    /// - Parameter name: A name such as `breathing`.
    /// - Returns: The effect, or `nil` for an unknown name.
    public init?(name: String) {
        guard let effect = Self.allCases.first(where: { $0.name == name }) else { return nil }
        self = effect
    }
}

extension LightEffect: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let index = try? container.decode(Int.self), let effect = LightEffect(rawValue: index) {
            self = effect
            return
        }
        let name = try container.decode(String.self)
        guard let effect = LightEffect(name: name) else {
            let names = Self.allCases.map(\.name).joined(separator: ", ")
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unknown effect \"\(name)\"; expected one of \(names)"
            )
        }
        self = effect
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(name)
    }
}

/// The light of one key, sent with `v.oai.thstatus`.
///
/// Per-key lights show only on a layer whose keys are `KV_OAI_AG*`,
/// such as the stock layer 4.
public struct KeyLight: Sendable, Hashable, Codable {
    /// The key's index, from 0 to 12.
    public var key: Int
    /// The color.
    public var color: LightColor
    /// The brightness, from 0 to 1.
    public var brightness: Double
    /// The animation.
    public var effect: LightEffect
    /// The animation speed, from 0 to 1.
    public var speed: Double

    /// Creates a key light.
    ///
    /// - Parameters:
    ///   - key: The key's index, from 0 to 12.
    ///   - color: The color.
    ///   - brightness: The brightness, clamped to 0...1.
    ///   - effect: The animation.
    ///   - speed: The animation speed, clamped to 0...1.
    public init(key: Int, color: LightColor, brightness: Double = 1, effect: LightEffect = .solid, speed: Double = 0.5)
    {
        self.key = key
        self.color = color
        self.brightness = brightness.clamped(to: 0 ... 1)
        self.effect = effect
        self.speed = speed.clamped(to: 0 ... 1)
    }

    private enum CodingKeys: String, CodingKey {
        case key, color, brightness, effect, speed
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            key: try container.decode(Int.self, forKey: .key),
            color: try container.decode(LightColor.self, forKey: .color),
            brightness: try container.decodeIfPresent(Double.self, forKey: .brightness) ?? 1,
            effect: try container.decodeIfPresent(LightEffect.self, forKey: .effect) ?? .solid,
            speed: try container.decodeIfPresent(Double.self, forKey: .speed) ?? 0.5
        )
    }

    /// The light that turns the key off.
    ///
    /// - Parameter key: The key's index.
    /// - Returns: A black light with the `off` effect.
    public static func off(key: Int) -> KeyLight {
        KeyLight(key: key, color: .black, brightness: 0, effect: .off, speed: 0)
    }

    /// The entry for this light in a `v.oai.thstatus` array: `{id, c, b, e, s}`.
    public var firmwareEntry: JSONValue {
        [
            "id": .number(Double(key)), "c": .number(Double(color.packed)), "b": .number(brightness),
            "e": .number(Double(effect.rawValue)), "s": .number(speed),
        ]
    }

    /// Parses a light from a `v.oai.thstatus` entry.
    ///
    /// - Parameter entry: An object with `id` and, optionally, `c`, `b`, `e`, and `s`.
    /// - Returns: The light, or `nil` if the entry has no `id`.
    public init?(firmwareEntry entry: JSONValue) {
        guard let key = entry["id"]?.intValue else { return nil }
        self.init(
            key: key,
            color: LightColor(packed: entry["c"]?.intValue ?? 0),
            brightness: entry["b"]?.doubleValue ?? 0,
            effect: entry["e"]?.intValue.flatMap(LightEffect.init(rawValue:)) ?? .off,
            speed: entry["s"]?.doubleValue ?? 0
        )
    }

    /// The `v.oai.thstatus` parameters for a set of key lights.
    ///
    /// - Parameter lights: The lights.
    /// - Returns: A bare array of firmware entries.
    public static func firmwareParams(_ lights: some Sequence<KeyLight>) -> JSONValue {
        .array(lights.map(\.firmwareEntry))
    }
}

/// The lighting of one zone, sent with `v.oai.rgbcfg`.
public struct ZoneLight: Sendable, Hashable, Codable {
    /// The color.
    public var color: LightColor
    /// The animation.
    public var effect: LightEffect
    /// The brightness, from 0 to 1.
    public var brightness: Double
    /// The animation speed, from 0 to 1.
    public var speed: Double

    /// Creates a zone light.
    ///
    /// - Parameters:
    ///   - color: The color.
    ///   - effect: The animation.
    ///   - brightness: The brightness, clamped to 0...1.
    ///   - speed: The animation speed, clamped to 0...1.
    public init(color: LightColor, effect: LightEffect = .solid, brightness: Double = 1, speed: Double = 0) {
        self.color = color
        self.effect = effect
        self.brightness = brightness.clamped(to: 0 ... 1)
        self.speed = speed.clamped(to: 0 ... 1)
    }

    private enum CodingKeys: String, CodingKey {
        case color, effect, brightness, speed
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            color: try container.decodeIfPresent(LightColor.self, forKey: .color) ?? .white,
            effect: try container.decodeIfPresent(LightEffect.self, forKey: .effect) ?? .solid,
            brightness: try container.decodeIfPresent(Double.self, forKey: .brightness) ?? 1,
            speed: try container.decodeIfPresent(Double.self, forKey: .speed) ?? 0
        )
    }

    /// The light that turns a zone off.
    public static let off = ZoneLight(color: .black, effect: .off, brightness: 0, speed: 0)

    /// The firmware form of this zone: `{e, b, s, m, c}`, with `m` always 1.
    public var firmwareEntry: JSONValue {
        [
            "e": .number(Double(effect.rawValue)), "b": .number(brightness), "s": .number(speed), "m": 1,
            "c": .number(Double(color.packed)),
        ]
    }

    /// Parses a zone from its firmware form.
    ///
    /// - Parameter entry: An object with `e`, `b`, `s`, and `c`.
    /// - Returns: The zone light, or `nil` if the entry is not an object.
    public init?(firmwareEntry entry: JSONValue) {
        guard entry.objectValue != nil else { return nil }
        self.init(
            color: LightColor(packed: entry["c"]?.intValue ?? 0),
            effect: entry["e"]?.intValue.flatMap(LightEffect.init(rawValue:)) ?? .off,
            brightness: entry["b"]?.doubleValue ?? 0,
            speed: entry["s"]?.doubleValue ?? 0
        )
    }
}

/// The two lighting zones: the key backlight and the ambient ring.
public struct ZoneLights: Sendable, Hashable, Codable {
    /// The backlight of keys that have no per-key light.
    public var keys: ZoneLight?
    /// The ambient ring (underglow).
    public var ambient: ZoneLight?

    /// Creates a pair of zones.
    ///
    /// - Parameters:
    ///   - keys: The key backlight, or `nil` if unset.
    ///   - ambient: The ambient ring, or `nil` if unset.
    public init(keys: ZoneLight? = nil, ambient: ZoneLight? = nil) {
        self.keys = keys
        self.ambient = ambient
    }

    /// Whether neither zone is set.
    public var isEmpty: Bool { keys == nil && ambient == nil }

    /// The `v.oai.rgbcfg` parameters: `{keys, ambient}`.
    ///
    /// The firmware is sent both zones,
    /// because whether it accepts one zone alone is untested;
    /// an unset zone goes out as ``ZoneLight/off``.
    public var firmwareParams: JSONValue {
        [
            "keys": (keys ?? .off).firmwareEntry,
            "ambient": (ambient ?? .off).firmwareEntry,
        ]
    }
}

extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double {
        guard !isNaN else { return range.lowerBound }
        return Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}
