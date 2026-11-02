import CreatorMicro

/// What the app knows about the keypad, in the bridge's form.
///
/// ```json
/// {"connected":true,"transport":"USB","firmware":"0.6.3","layer":2,"battery":64,"charging":true,
///  "inputLayers":[2,4],"lightableKeys":{"2":[0,1,2,3,4,5,6],"4":[0,1,2,3,4,5]},"lightsVisible":true,
///  "chatGPTLayer":4,"chatGPTRunning":true,"lightsPaused":false,
///  "lightingStatus":"not paused; repainted every 30 seconds while ChatGPT runs"}
/// ```
public struct KeypadState: Sendable, Hashable, Codable {
    /// Whether a keypad is connected.
    public var connected: Bool
    /// The connection, such as `USB` or `Emulated`, or `nil` when disconnected.
    public var transport: String?
    /// The firmware version, once known.
    public var firmware: String?
    /// The active layer, from 1, once known.
    public var layer: Int?
    /// The battery charge, in percent, once known.
    public var battery: Int?
    /// Whether the battery is charging, once known.
    public var charging: Bool?
    /// The layers, from 1 and in order, whose inputs reach the app and whose keys show per-key lights:
    /// the layers with vendor codes in the keypad's keymap (see ``InputLayers``),
    /// or layer 4 when the keymap could not be read.
    public var inputLayers: [Int]
    /// The keys that show per-key lights on each of ``inputLayers``, in order:
    /// the keys that the layer binds to `KV_OAI_AG00`–`KV_OAI_AG12` (see ``InputLayers``).
    /// A key that the layer binds to another code shows the key backlight zone instead.
    public var lightableKeys: [Int: [Int]]
    /// Whether per-key lights show and inputs arrive: the keypad is connected
    /// and its layer is one of ``inputLayers``.
    public var lightsVisible: Bool
    /// The layer that Codex drives, from 1:
    /// the keymap's layer named "ChatGPT", else layer 4 (see ``InputLayers/chatGPTLayer(keymap:)``).
    public var chatGPTLayer: Int
    /// Whether the ChatGPT app runs and can reach the keypad;
    /// the app reports `false` for the emulated keypad, which Codex does not reach.
    public var chatGPTRunning: Bool

    /// Creates a state.
    ///
    /// - Parameters:
    ///   - connected: Whether a keypad is connected.
    ///   - transport: The connection.
    ///   - firmware: The firmware version.
    ///   - layer: The active layer, from 1.
    ///   - battery: The battery charge, in percent.
    ///   - charging: Whether the battery is charging.
    ///   - inputLayers: The layers whose inputs reach the app.
    ///   - lightableKeys: The keys that show per-key lights on each input layer;
    ///     a layer that it leaves out has ``InputLayers/stockLightableKeys``.
    ///   - chatGPTLayer: The layer that Codex drives.
    ///   - chatGPTRunning: Whether the ChatGPT app runs and can reach the keypad.
    public init(
        connected: Bool,
        transport: String? = nil,
        firmware: String? = nil,
        layer: Int? = nil,
        battery: Int? = nil,
        charging: Bool? = nil,
        inputLayers: Set<Int> = InputLayers.fallback,
        lightableKeys: [Int: Set<Int>] = [:],
        chatGPTLayer: Int = InputLayers.fallbackChatGPTLayer,
        chatGPTRunning: Bool = false
    ) {
        self.connected = connected
        self.transport = transport
        self.firmware = firmware
        self.layer = layer
        self.battery = battery
        self.charging = charging
        self.inputLayers = inputLayers.sorted()
        self.lightableKeys = Self.lightableKeys(lightableKeys, on: inputLayers)
        self.lightsVisible = connected && layer.map(inputLayers.contains) == true
        self.chatGPTLayer = chatGPTLayer
        self.chatGPTRunning = chatGPTRunning
    }

    /// Whether the app holds its lighting writes:
    /// the ChatGPT app runs and the keypad is on ``chatGPTLayer``, or its layer is not yet known.
    ///
    /// On any other layer, the app keeps writing its lights while ChatGPT runs,
    /// and paints them again every ``KeypadSession/chatGPTRepaintInterval``,
    /// because Codex resets per-key lights.
    public var lightsPaused: Bool {
        chatGPTRunning && (layer == nil || layer == chatGPTLayer)
    }

    /// Why lighting is paused, or that it is not, for people, such as
    /// `paused on the ChatGPT layer (layer 4) while ChatGPT runs`.
    public var lightingStatus: String {
        guard chatGPTRunning else { return "not paused" }
        guard let layer else { return "paused while ChatGPT runs, until the keypad reports its layer" }
        if layer == chatGPTLayer { return "paused on the ChatGPT layer (layer \(layer)) while ChatGPT runs" }
        let seconds = KeypadSession.chatGPTRepaintInterval.components.seconds
        return "not paused; repainted every \(seconds) seconds while ChatGPT runs"
    }

    /// The keys that show per-key lights on the active layer:
    /// its ``lightableKeys`` on an input layer, else none.
    public var litKeysOnLayer: Set<Int> {
        layer.flatMap { lightableKeys[$0] }.map(Set.init) ?? []
    }

    /// Whether the active layer is one of ``inputLayers``, whether or not a keypad is connected.
    public var isOnInputLayer: Bool {
        layer.map(inputLayers.contains) == true
    }

    /// The active layer for the menu, such as `2 (Paseo layer)`, `1`, or `—` when it is unknown.
    public var layerDescription: String {
        guard let layer else { return "—" }
        return isOnInputLayer ? "\(layer) (Paseo layer)" : "\(layer)"
    }

    /// The input layers for a sentence, such as `layer 4`, `layer 2 or 4`, or `none in the keymap`.
    public var inputLayerList: String {
        switch inputLayers.count {
        case 0: return "none in the keymap"
        case 1: return "layer \(inputLayers[0])"
        default:
            let numbers = inputLayers.map(String.init)
            return "layer " + numbers.dropLast().joined(separator: ", ") + " or " + numbers[numbers.count - 1]
        }
    }

    /// The state with no keypad connected.
    public static let disconnected = KeypadState(connected: false)

    private static func lightableKeys(_ keys: [Int: Set<Int>], on layers: some Sequence<Int>) -> [Int: [Int]] {
        Dictionary(uniqueKeysWithValues: layers.map { ($0, (keys[$0] ?? InputLayers.stockLightableKeys).sorted()) })
    }

    private enum CodingKeys: String, CodingKey {
        case connected, transport, firmware, layer, battery, charging, inputLayers, lightableKeys, lightsVisible
        case chatGPTLayer, chatGPTRunning, lightsPaused, lightingStatus
    }

    /// Decodes a state; a state from an app without `inputLayers` has layer 4 alone,
    /// one without `lightableKeys` has keys 0–5 on each input layer,
    /// and one without `chatGPTLayer` or `chatGPTRunning` has layer 4 and `false`.
    /// ``lightsPaused`` and ``lightingStatus`` follow from the other fields, so they are not read.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        connected = try container.decode(Bool.self, forKey: .connected)
        transport = try container.decodeIfPresent(String.self, forKey: .transport)
        firmware = try container.decodeIfPresent(String.self, forKey: .firmware)
        layer = try container.decodeIfPresent(Int.self, forKey: .layer)
        battery = try container.decodeIfPresent(Int.self, forKey: .battery)
        charging = try container.decodeIfPresent(Bool.self, forKey: .charging)
        inputLayers =
            try container.decodeIfPresent([Int].self, forKey: .inputLayers) ?? InputLayers.fallback.sorted()
        let keys = try container.decodeIfPresent([String: [Int]].self, forKey: .lightableKeys) ?? [:]
        let byLayer = Dictionary(
            keys.compactMap { key, value in Int(key).map { ($0, Set(value)) } },
            uniquingKeysWith: { first, _ in first }
        )
        lightableKeys = Self.lightableKeys(byLayer, on: inputLayers)
        lightsVisible = try container.decode(Bool.self, forKey: .lightsVisible)
        chatGPTLayer =
            try container.decodeIfPresent(Int.self, forKey: .chatGPTLayer) ?? InputLayers.fallbackChatGPTLayer
        chatGPTRunning = try container.decodeIfPresent(Bool.self, forKey: .chatGPTRunning) ?? false
    }

    /// Encodes a state, with ``lightableKeys`` as an object whose names are the layers,
    /// and with ``lightsPaused`` and ``lightingStatus``.
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(connected, forKey: .connected)
        try container.encodeIfPresent(transport, forKey: .transport)
        try container.encodeIfPresent(firmware, forKey: .firmware)
        try container.encodeIfPresent(layer, forKey: .layer)
        try container.encodeIfPresent(battery, forKey: .battery)
        try container.encodeIfPresent(charging, forKey: .charging)
        try container.encode(inputLayers, forKey: .inputLayers)
        let keys = Dictionary(uniqueKeysWithValues: lightableKeys.map { (String($0.key), $0.value) })
        try container.encode(keys, forKey: .lightableKeys)
        try container.encode(lightsVisible, forKey: .lightsVisible)
        try container.encode(chatGPTLayer, forKey: .chatGPTLayer)
        try container.encode(chatGPTRunning, forKey: .chatGPTRunning)
        try container.encode(lightsPaused, forKey: .lightsPaused)
        try container.encode(lightingStatus, forKey: .lightingStatus)
    }
}
