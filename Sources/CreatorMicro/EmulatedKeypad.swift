import Foundation
import Synchronization

/// A keypad in software that answers like a Creator Micro 2 with firmware 0.6.3.
///
/// The emulated keypad works at the level of reports,
/// so it exercises the same framing and reassembly as the real keypad.
/// It answers `sys.version`, `device.status`, the lighting methods, `fs.list`, and `fs.read`,
/// answers `{"ok":1}` to anything else, as the firmware does,
/// and remembers every request and the lights it was given.
/// Tests and the app's emulator mode use it to inject inputs:
///
/// ```swift
/// let keypad = EmulatedKeypad()
/// let client = KeypadClient(transport: keypad)
/// await client.start()
/// keypad.tap(key: 3)
/// ```
public final class EmulatedKeypad: KeypadTransport {
    /// The firmware version that the emulated keypad reports.
    public static let firmwareVersion = "0.6.3"

    /// The device that the emulated keypad reports.
    public static let defaultDevice = KeypadDevice(productID: 0x8298, product: "Creator Micro 2", transport: "Emulated")

    private struct State {
        var handler: (@Sendable (KeypadTransportEvent) -> Void)?
        var isPluggedIn: Bool
        var layer: Int
        var battery: Int
        var isCharging: Bool
        var keymap: String
        var isResponding = true
        var heldMethods: Set<String> = []
        var heldReplies: [RPCMessage] = []
        var keyLights: [Int: KeyLight] = [:]
        var zones = ZoneLights()
        var requests: [RPCRequest] = []
        var reassembler = MessageReassembler()
    }

    private let state: Mutex<State>
    private let queue = DispatchQueue(label: "co.dododo.paseo-micro.emulated-keypad")
    private let device: KeypadDevice

    /// Creates an emulated keypad.
    ///
    /// - Parameters:
    ///   - layer: The active layer, from 1; layer 4 is the stock "ChatGPT" layer.
    ///   - battery: The battery charge, in percent.
    ///   - isCharging: Whether the battery is charging.
    ///   - isPluggedIn: Whether the keypad is present when the transport starts.
    ///   - keymap: The text of `keymap.json`; by default a reduced stock keymap
    ///     whose only layer with vendor codes is layer 4.
    ///   - device: The device that the keypad reports.
    public init(
        layer: Int = 4,
        battery: Int = 64,
        isCharging: Bool = true,
        isPluggedIn: Bool = true,
        keymap: String = EmulatedKeypad.stockKeymap,
        device: KeypadDevice = EmulatedKeypad.defaultDevice
    ) {
        self.device = device
        state = Mutex(
            State(isPluggedIn: isPluggedIn, layer: layer, battery: battery, isCharging: isCharging, keymap: keymap)
        )
    }

    // MARK: - KeypadTransport

    public func start(_ handler: @escaping @Sendable (KeypadTransportEvent) -> Void) {
        let isPluggedIn = state.withLock { state in
            state.handler = handler
            return state.isPluggedIn
        }
        if isPluggedIn { emit([.connected(device)]) }
    }

    public func stop() {
        state.withLock { $0.handler = nil }
    }

    public func send(_ reports: [[UInt8]]) async throws {
        let replies = try state.withLock { state -> [RPCMessage] in
            guard state.isPluggedIn else { throw KeypadError.notConnected }
            var replies: [RPCMessage] = []
            for report in reports {
                guard let frame = Report.Frame(report: report), frame.channel == .rpc else { continue }
                for bytes in state.reassembler.append(frame.payload) {
                    guard let json = try? JSONValue(parsing: Data(bytes)), let request = RPCRequest(json: json) else {
                        continue
                    }
                    state.requests.append(request)
                    let result = Self.answer(request, state: &state)
                    guard state.isResponding else { continue }
                    let reply = RPCMessage.reply(id: request.id, result: result, error: nil)
                    if state.heldMethods.contains(request.method) {
                        state.heldReplies.append(reply)
                    } else {
                        replies.append(reply)
                    }
                }
            }
            return replies
        }
        for reply in replies { emit(message: reply) }
    }

    // MARK: - State

    /// The active layer, from 1.
    public var layer: Int { state.withLock { $0.layer } }

    /// Whether the keypad is plugged in.
    public var isPluggedIn: Bool { state.withLock { $0.isPluggedIn } }

    /// The per-key lights that the keypad was given, by key.
    public var keyLights: [Int: KeyLight] { state.withLock { $0.keyLights } }

    /// The zone lights that the keypad was given last.
    public var zones: ZoneLights { state.withLock { $0.zones } }

    /// Every request that the keypad received, in order.
    public var requests: [RPCRequest] { state.withLock { $0.requests } }

    /// Whether the keypad replies to requests.
    ///
    /// Set it to `false` to test timeouts: the keypad still records requests.
    public var isResponding: Bool {
        get { state.withLock { $0.isResponding } }
        set { state.withLock { $0.isResponding = newValue } }
    }

    /// Holds the replies to some methods until ``releaseHeldReplies()``.
    ///
    /// The keypad still applies and records the held requests when they arrive.
    /// Tests use it to delay replies, so that they can send other calls while one waits.
    ///
    /// - Parameter methods: The methods whose replies wait, such as `v.oai.thstatus`.
    public func holdReplies(to methods: Set<String>) {
        state.withLock { $0.heldMethods = methods }
    }

    /// Sends the held replies, in order, and stops holding replies.
    public func releaseHeldReplies() {
        let replies = state.withLock { state in
            defer {
                state.heldMethods = []
                state.heldReplies = []
            }
            return state.heldReplies
        }
        for reply in replies { emit(message: reply) }
    }

    /// Replaces the text of `keymap.json`, as a write by another program would.
    ///
    /// - Parameter keymap: The new text.
    public func setKeymap(_ keymap: String) {
        state.withLock { $0.keymap = keymap }
    }

    /// Switches the active layer, as the layer keys on the keypad do.
    ///
    /// - Parameter layer: The new layer, from 1.
    public func setLayer(_ layer: Int) {
        state.withLock { $0.layer = layer }
    }

    /// Changes the battery charge and charging state.
    ///
    /// - Parameters:
    ///   - battery: The charge, in percent.
    ///   - isCharging: Whether the battery is charging.
    public func setBattery(_ battery: Int, isCharging: Bool) {
        state.withLock { state in
            state.battery = battery
            state.isCharging = isCharging
        }
    }

    /// Forgets the recorded requests.
    public func clearRequests() {
        state.withLock { $0.requests.removeAll() }
    }

    /// Unplugs the keypad: the transport reports a disconnection, and sends fail.
    ///
    /// The keypad forgets its lights, as a real keypad does when it loses power.
    public func unplug() {
        let wasPluggedIn = state.withLock { state in
            defer {
                state.isPluggedIn = false
                state.keyLights = [:]
                state.zones = ZoneLights()
                state.reassembler.reset()
            }
            return state.isPluggedIn
        }
        if wasPluggedIn { emit([.disconnected]) }
    }

    /// Plugs the keypad back in: the transport reports a connection.
    public func plugIn() {
        let wasPluggedIn = state.withLock { state in
            defer { state.isPluggedIn = true }
            return state.isPluggedIn
        }
        if !wasPluggedIn { emit([.connected(device)]) }
    }

    // MARK: - Inputs

    /// Sends an input notification, as the keypad does on layer 4.
    ///
    /// - Parameter input: The input to send.
    public func send(_ input: KeypadInput) {
        emit(message: input.notification)
    }

    /// Presses and releases a key.
    ///
    /// - Parameter key: The key's index, from 0 to 12.
    public func tap(key: Int) {
        send(.key(KeyInput(key: key, action: .press)))
        send(.key(KeyInput(key: key, action: .release)))
    }

    /// Turns the dial one step.
    ///
    /// - Parameter clockwise: `true` for a clockwise step, `false` for counterclockwise.
    public func turnDial(clockwise: Bool) {
        send(.dial(clockwise ? .clockwise : .counterclockwise))
    }

    /// Presses and releases the dial.
    public func clickDial() {
        send(.dial(.press))
        send(.dial(.release))
    }

    /// Moves the joystick.
    ///
    /// - Parameters:
    ///   - angle: The direction, from 0 to 1, counterclockwise from east.
    ///   - distance: The distance from the center, from 0 to 1.
    ///   - sector: The sector, from 0 to 7, or -1 at rest.
    public func moveJoystick(angle: Double, distance: Double, sector: Int) {
        send(.joystick(JoystickInput(angle: angle, distance: distance, sector: sector)))
    }

    /// Sends any message, such as a reply to another program's request.
    ///
    /// - Parameter message: The message to send.
    public func emit(message: RPCMessage) {
        var bytes = Array(message.json.encoded())
        bytes += Array("\r\n".utf8)
        emit(Report.reports(for: bytes, channel: .rpc).map(KeypadTransportEvent.report))
    }

    // MARK: - Private

    private func emit(_ events: [KeypadTransportEvent]) {
        guard let handler = state.withLock({ $0.handler }) else { return }
        queue.async {
            for event in events { handler(event) }
        }
    }

    private static func answer(_ request: RPCRequest, state: inout State) -> JSONValue {
        switch request.method {
        case KeypadMethod.version:
            return ["version": .string(firmwareVersion)]
        case KeypadMethod.status:
            return KeypadStatus(
                battery: state.battery,
                isCharging: state.isCharging,
                layer: state.layer,
                profile: 0,
                version: firmwareVersion
            ).result
        case KeypadMethod.keyLights:
            for entry in request.params?.arrayValue ?? [] {
                if let light = KeyLight(firmwareEntry: entry) { state.keyLights[light.key] = light }
            }
            return ["ok": 1]
        case KeypadMethod.zones:
            if let keys = request.params?["keys"].flatMap(ZoneLight.init(firmwareEntry:)) {
                state.zones.keys = keys
            }
            if let ambient = request.params?["ambient"].flatMap(ZoneLight.init(firmwareEntry:)) {
                state.zones.ambient = ambient
            }
            return ["ok": 1]
        case KeypadMethod.listFiles:
            return [
                ["dir": false, "name": "keymap.json", "size": .number(Double(state.keymap.utf8.count))],
                ["dir": false, "name": "smart_actions.json", "size": .number(Double(smartActions.utf8.count))],
            ]
        case KeypadMethod.readFile:
            switch request.params?["file"]?.stringValue {
            case "keymap.json": return ["data": .string(state.keymap)]
            case "smart_actions.json": return ["data": .string(smartActions)]
            default: return ["ok": 1]
            }
        default:
            return ["ok": 1]
        }
    }

    private static let smartActions = #"{"version":1,"actions":[],"metadata":{}}"#

    /// A reduced stock keymap in the firmware's form: one profile with four layers,
    /// of which only layer 4, "ChatGPT", has vendor codes (`KV_OAI_…`).
    public static let stockKeymap = #"""
        {"version":1,"activeProfileId":0,"profiles":[{"id":0,"name":"Default","layers":[\#
        {"id":0,"name":"Layer 1","layout":{"keymap":[["KC_A","KC_B"]],"encoders":[["KC_VOLU","KC_VOLD","KC_MPLY"]],\#
        "joystick":{"type":"RADIAL","sectors":[{"k":"KC_P1","a1":0.1875,"a2":0.3125}]}}},\#
        {"id":1,"name":"Layer 2","layout":{"keymap":[["KC_NONE","KC_NONE"]],"encoders":[["KC_NONE","KC_NONE","KC_NONE"]],\#
        "joystick":{"type":"JOYSTICK","sectors":[]}}},\#
        {"id":2,"name":"Layer 3","layout":{"keymap":[["KC_NONE","KC_NONE"]],"encoders":[["KC_NONE","KC_NONE","KC_NONE"]],\#
        "joystick":{"type":"JOYSTICK","sectors":[]}}},\#
        {"id":3,"name":"ChatGPT","layout":{"keymap":[["KV_OAI_AG00","KV_OAI_AG01"],\#
        ["KV_OAI_AG02","KV_OAI_AG03","KV_OAI_AG04","KV_OAI_AG05"],\#
        ["KV_OAI_ACT06","KV_OAI_ACT07","KV_OAI_ACT08","KV_OAI_ACT09"],["KV_OAI_ACT10","KV_OAI_ACT11","KV_OAI_ACT12"]],\#
        "encoders":[["KV_OAI_ENC_CC","KV_OAI_ENC_CW","KV_OAI_ENC_CLK"]],"joystick":{"type":"VENDOR","sectors":[]}}}]}]}
        """#
}
