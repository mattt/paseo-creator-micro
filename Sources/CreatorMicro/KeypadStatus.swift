/// The reply to `device.status`.
public struct KeypadStatus: Sendable, Hashable {
    /// The battery charge, in percent.
    public var battery: Int?
    /// Whether the battery is charging.
    public var isCharging: Bool?
    /// The active layer, from 1.
    public var layer: Int?
    /// The active profile, from 0.
    public var profile: Int?
    /// The firmware version.
    public var version: String?

    /// Creates a status.
    ///
    /// - Parameters:
    ///   - battery: The battery charge, in percent.
    ///   - isCharging: Whether the battery is charging.
    ///   - layer: The active layer, from 1.
    ///   - profile: The active profile, from 0.
    ///   - version: The firmware version.
    public init(
        battery: Int? = nil,
        isCharging: Bool? = nil,
        layer: Int? = nil,
        profile: Int? = nil,
        version: String? = nil
    ) {
        self.battery = battery
        self.isCharging = isCharging
        self.layer = layer
        self.profile = profile
        self.version = version
    }

    /// Parses a status from the `device.status` result.
    ///
    /// - Parameter result: An object such as
    ///   `{"battery":50,"is_charging":true,"layer_index":1,"profile_index":0,"version":"0.6.3"}`.
    /// - Returns: The status, or `nil` if the result is not an object.
    public init?(result: JSONValue) {
        guard result.objectValue != nil else { return nil }
        battery = result["battery"]?.intValue
        isCharging = result["is_charging"]?.boolValue ?? result["is_charging"]?.intValue.map { $0 != 0 }
        layer = result["layer_index"]?.intValue
        profile = result["profile_index"]?.intValue
        version = result["version"]?.stringValue
    }

    /// The status as the firmware sends it.
    public var result: JSONValue {
        var object: [String: JSONValue] = [:]
        if let battery { object["battery"] = .number(Double(battery)) }
        if let isCharging { object["is_charging"] = .bool(isCharging) }
        if let layer { object["layer_index"] = .number(Double(layer)) }
        if let profile { object["profile_index"] = .number(Double(profile)) }
        if let version { object["version"] = .string(version) }
        return .object(object)
    }
}
