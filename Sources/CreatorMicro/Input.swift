import Foundation

/// An input from the keypad: a key, the dial, or the joystick.
///
/// On the stock "ChatGPT" layer (layer 4),
/// keys and the dial arrive as `v.oai.hid` notifications,
/// and the joystick arrives as `kb.radial` (or `v.oai.rad` on older firmware).
///
/// The `Codable` form is the bridge's form, such as
/// `{"kind":"key","key":3,"code":"AG03","action":"press"}`.
public enum KeypadInput: Sendable, Hashable {
    /// A key went down or up.
    case key(KeyInput)
    /// The dial turned one step or was pressed or released.
    case dial(DialAction)
    /// The joystick moved.
    case joystick(JoystickInput)

    /// The notification method for keys and the dial.
    public static let hidMethod = "v.oai.hid"
    /// The notification method for the joystick.
    public static let radialMethod = "kb.radial"
    /// The joystick notification method of older firmware.
    public static let legacyRadialMethod = "v.oai.rad"

    /// Parses an input from a keypad notification.
    ///
    /// - Parameters:
    ///   - method: The notification's `m` member.
    ///   - params: The notification's `p` member.
    /// - Returns: The input, or `nil` if the notification is not an input this type knows.
    public init?(method: String, params: JSONValue?) {
        switch method {
        case Self.hidMethod:
            guard let code = params?["k"]?.stringValue, let act = params?["act"]?.intValue else { return nil }
            if let dial = DialAction(code: code, act: act) {
                self = .dial(dial)
            } else if let key = KeyInput(code: code, act: act) {
                self = .key(key)
            } else {
                return nil
            }
        case Self.radialMethod, Self.legacyRadialMethod:
            guard let joystick = JoystickInput(params: params) else { return nil }
            self = .joystick(joystick)
        default:
            return nil
        }
    }

    /// The notification that the firmware sends for this input.
    ///
    /// The emulated keypad uses this to send inputs.
    public var notification: RPCMessage {
        switch self {
        case .key(let key):
            return .notification(
                method: Self.hidMethod,
                params: ["k": .string(key.code), "act": key.action == .press ? 1 : 0]
            )
        case .dial(let action):
            return .notification(
                method: Self.hidMethod,
                params: ["k": .string(action.code), "act": .number(Double(action.act))]
            )
        case .joystick(let joystick):
            return .notification(
                method: Self.radialMethod,
                params: [
                    "a": .number(JoystickInput.firmwareAngle(joystick.angle)), "d": .number(joystick.distance),
                    "s": .number(Double(joystick.sector)), "l": 0, "o": 2, "p": 0,
                ]
            )
        }
    }
}

/// Whether a key went down or up.
public enum KeyAction: String, Sendable, Hashable, Codable, CaseIterable {
    /// The key went down (`act` 1).
    case press
    /// The key came up (`act` 0).
    case release
}

/// A key event on the ChatGPT layer.
public struct KeyInput: Sendable, Hashable, Codable {
    /// The number of keys on the keypad.
    public static let count = 13

    /// The indexes of the codes `AG13` to `AG19`, which no physical key sends on the stock keymap.
    ///
    /// A keymap can bind them to another control, such as the joystick's sectors,
    /// so the app forwards them as keys with these indexes.
    /// They have no key lights.
    public static let unlitKeys = 13 ... 19

    /// The key's index: 0 to 12 for the physical keys, left to right and top to bottom
    /// in rows of 2, 4, 4, and 3, or 13 to 19 for the codes in ``unlitKeys``.
    public var key: Int
    /// The firmware's code for the key: `AG00` to `AG05` for keys 0 to 5,
    /// `ACT06` to `ACT12` for keys 6 to 12 on the stock keymap, or `AG06` to `AG12`
    /// on a layer that binds them to those codes so that they can show their own lights,
    /// and `AG13` to `AG19` for ``unlitKeys``.
    public var code: String
    /// Whether the key went down or up.
    public var action: KeyAction

    /// Creates a key event with the stock code for the key.
    ///
    /// - Parameters:
    ///   - key: The key's index, from 0 to 12, or from 13 to 19 for ``unlitKeys``.
    ///   - action: Whether the key went down or up.
    public init(key: Int, action: KeyAction) {
        self.key = key
        self.code = Self.code(for: key)
        self.action = action
    }

    /// Parses a key event from a `v.oai.hid` code and action.
    ///
    /// - Parameters:
    ///   - code: The `k` member, such as `AG03` or `ACT10`.
    ///   - act: The `act` member: 1 for press, 0 for release.
    /// - Returns: The key event, or `nil` for another code or action.
    ///   `AG06` to `AG12` are keys 6 to 12, as `ACT06` to `ACT12` are;
    ///   `AG13` to `AG19` are keys 13 to 19 (``unlitKeys``); `ACT13` and above are not keys.
    public init?(code: String, act: Int) {
        let digits: Substring
        let range: ClosedRange<Int>
        if code.hasPrefix("AG") {
            digits = code.dropFirst(2)
            range = 0 ... Self.unlitKeys.upperBound
        } else if code.hasPrefix("ACT") {
            digits = code.dropFirst(3)
            range = 0 ... Self.count - 1
        } else {
            return nil
        }
        guard !digits.isEmpty, digits.allSatisfy(\.isASCII), let key = Int(digits), range.contains(key)
        else { return nil }
        switch act {
        case 1: action = .press
        case 0: action = .release
        default: return nil
        }
        self.key = key
        self.code = code
    }

    /// Returns the stock layer 4 code for a key.
    ///
    /// - Parameter key: The key's index, from 0 to 19.
    /// - Returns: `AG00` to `AG05` for keys 0 to 5, `ACT06` to `ACT12` for keys 6 to 12,
    ///   and `AG13` to `AG19` for keys 13 to 19.
    public static func code(for key: Int) -> String {
        let number = key < 10 ? "0\(key)" : "\(key)"
        return key < 6 || key >= count ? "AG\(number)" : "ACT\(number)"
    }
}

/// A dial event.
///
/// The firmware names follow the keymap's encoder slots, not the direction:
/// the clockwise slot holds `ENC_CC`, and the counterclockwise slot holds `ENC_CW`.
public enum DialAction: String, Sendable, Hashable, Codable, CaseIterable {
    /// One step clockwise (`ENC_CC`, `act` 2).
    case clockwise
    /// One step counterclockwise (`ENC_CW`, `act` 2).
    case counterclockwise
    /// The dial went down (`ENC_CLK`, `act` 1).
    case press
    /// The dial came up (`ENC_CLK`, `act` 0).
    case release

    /// Parses a dial event from a `v.oai.hid` code and action.
    ///
    /// - Parameters:
    ///   - code: The `k` member: `ENC_CC`, `ENC_CW`, or `ENC_CLK`.
    ///   - act: The `act` member.
    /// - Returns: The dial event, or `nil` for another code or action.
    public init?(code: String, act: Int) {
        switch (code, act) {
        case ("ENC_CC", 2): self = .clockwise
        case ("ENC_CW", 2): self = .counterclockwise
        case ("ENC_CLK", 1): self = .press
        case ("ENC_CLK", 0): self = .release
        default: return nil
        }
    }

    /// The firmware's code for the event.
    public var code: String {
        switch self {
        case .clockwise: "ENC_CC"
        case .counterclockwise: "ENC_CW"
        case .press, .release: "ENC_CLK"
        }
    }

    /// The firmware's `act` value for the event.
    public var act: Int {
        switch self {
        case .clockwise, .counterclockwise: 2
        case .press: 1
        case .release: 0
        }
    }
}

/// A joystick position.
///
/// The angle is counterclockwise from east as seen from above: up is 0.25 and down is 0.75.
/// The firmware counts the other way (up 0.75, down 0.25; checked on the keypad on 2026-10-28),
/// so parsing and encoding the firmware's `a` mirror it.
public struct JoystickInput: Sendable, Hashable, Codable {
    /// The direction, from 0 to 1, counterclockwise from east.
    public var angle: Double
    /// The distance from the center, from 0 to 1.
    public var distance: Double
    /// The sector, from 0 to 7, or -1 when the joystick is at rest.
    public var sector: Int

    /// Creates a joystick position.
    ///
    /// - Parameters:
    ///   - angle: The direction, from 0 to 1, counterclockwise from east.
    ///   - distance: The distance from the center, from 0 to 1.
    ///   - sector: The sector, from 0 to 7, or -1 at rest.
    public init(angle: Double, distance: Double, sector: Int) {
        self.angle = angle
        self.distance = distance
        self.sector = sector
    }

    /// Parses a joystick position from `kb.radial` or `v.oai.rad` parameters.
    ///
    /// - Parameter params: An object with `a`, `d`, and `s`.
    /// - Returns: The position, or `nil` if a member is missing.
    public init?(params: JSONValue?) {
        guard let angle = params?["a"]?.doubleValue, let distance = params?["d"]?.doubleValue,
            let sector = params?["s"]?.intValue
        else { return nil }
        self.init(angle: Self.firmwareAngle(angle), distance: distance, sector: sector)
    }

    /// Converts between the firmware's angle and this type's angle; the conversion is its own inverse.
    ///
    /// - Parameter angle: An angle from 0 to 1 in either convention.
    /// - Returns: The angle mirrored across the east-west axis, from 0 to less than 1.
    public static func firmwareAngle(_ angle: Double) -> Double {
        let mirrored = 1 - angle
        return mirrored >= 1 ? mirrored - 1 : mirrored
    }

    /// Whether the joystick is at rest.
    public var isAtRest: Bool { sector < 0 }
}

extension KeypadInput: Codable {
    private enum CodingKeys: String, CodingKey {
        case kind, key, code, action, angle, distance, sector
    }

    private enum Kind: String, Codable {
        case key, dial, joystick
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .key:
            let key = try container.decode(Int.self, forKey: .key)
            let action = try container.decode(KeyAction.self, forKey: .action)
            var input = KeyInput(key: key, action: action)
            if let code = try container.decodeIfPresent(String.self, forKey: .code) { input.code = code }
            self = .key(input)
        case .dial:
            self = .dial(try container.decode(DialAction.self, forKey: .action))
        case .joystick:
            self = .joystick(
                JoystickInput(
                    angle: try container.decode(Double.self, forKey: .angle),
                    distance: try container.decode(Double.self, forKey: .distance),
                    sector: try container.decode(Int.self, forKey: .sector)
                )
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .key(let key):
            try container.encode(Kind.key, forKey: .kind)
            try container.encode(key.key, forKey: .key)
            try container.encode(key.code, forKey: .code)
            try container.encode(key.action, forKey: .action)
        case .dial(let action):
            try container.encode(Kind.dial, forKey: .kind)
            try container.encode(action, forKey: .action)
        case .joystick(let joystick):
            try container.encode(Kind.joystick, forKey: .kind)
            try container.encode(joystick.angle, forKey: .angle)
            try container.encode(joystick.distance, forKey: .distance)
            try container.encode(joystick.sector, forKey: .sector)
        }
    }
}

extension KeypadInput: CustomStringConvertible {
    public var description: String {
        switch self {
        case .key(let key): "key \(key.key) (\(key.code)) \(key.action.rawValue)"
        case .dial(let action): "dial \(action.rawValue)"
        case .joystick(let joystick):
            joystick.isAtRest
                ? "joystick at rest"
                : "joystick sector \(joystick.sector), angle \(joystick.angle.formatted(.number.precision(.fractionLength(2))))"
        }
    }
}
