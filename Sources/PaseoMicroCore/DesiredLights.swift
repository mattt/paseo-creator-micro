import CreatorMicro

/// The lights that the app wants on the keypad.
///
/// The keypad does not save lighting,
/// so the session sends these lights again after a reconnect
/// and when the keypad returns to an input layer.
public struct DesiredLights: Sendable, Hashable {
    /// The per-key lights, by key.
    public private(set) var keys: [Int: KeyLight] = [:]
    /// The zone lights.
    public var zones = ZoneLights()

    /// Creates an empty set of lights.
    public init() {}

    /// Whether no light is set.
    public var isEmpty: Bool { keys.isEmpty && zones.isEmpty }

    /// Sets lights for some keys and keeps the others.
    ///
    /// - Parameter lights: The lights; a later light for the same key wins.
    public mutating func set(_ lights: some Sequence<KeyLight>) {
        for light in lights { keys[light.key] = light }
    }

    /// Returns the per-key light of a key, if one is set.
    ///
    /// - Parameter key: The key's index.
    /// - Returns: The light, or `nil`.
    public func light(forKey key: Int) -> KeyLight? {
        keys[key]
    }

    /// The color that a key shows: its own light, or else the key backlight zone.
    ///
    /// - Parameter key: The key's index.
    /// - Returns: The color and brightness, or `nil` if the key is dark or unset.
    public func displayedColor(forKey key: Int) -> (color: LightColor, brightness: Double)? {
        if let light = keys[key] {
            return light.effect == .off ? nil : (light.color, light.brightness)
        }
        if let zone = zones.keys, zone.effect != .off {
            return (zone.color, zone.brightness)
        }
        return nil
    }
}

extension DesiredLights: Codable {
    private enum CodingKeys: String, CodingKey {
        case keys, zones
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        set(try container.decodeIfPresent([KeyLight].self, forKey: .keys) ?? [])
        zones = try container.decodeIfPresent(ZoneLights.self, forKey: .zones) ?? ZoneLights()
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(keys.values.sorted { $0.key < $1.key }, forKey: .keys)
        try container.encode(zones, forKey: .zones)
    }
}
