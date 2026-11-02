import CreatorMicro
import Foundation

/// The version of the bridge protocol that the app speaks.
public let bridgeProtocolVersion = 1

/// A message from the app to a bridge client: one JSON object per line.
public enum BridgeMessage: Sendable, Hashable {
    /// The first message on every connection:
    /// `{"type":"hello","protocol":1,"app":{"version"},"keypad":{…},"selectedWorkspaceId":"…"}`,
    /// where `selectedWorkspaceId` is the workspace that a client last stored with `setSelection`,
    /// and is missing when none is stored.
    case hello(protocolVersion: Int, appVersion: String, keypad: KeypadState, selectedWorkspaceID: String? = nil)
    /// The keypad's state changed: `{"type":"keypad","keypad":{…}}`.
    case keypad(KeypadState)
    /// The keypad sent an input: `{"type":"input","input":{…}}`.
    case input(KeypadInput)
    /// The joystick picked a slot of the radial menu, to the client that set the menu:
    /// `{"type":"input","input":{"kind":"radial","slot":0}}`, with slot 0 up and the others clockwise.
    case radialPick(slot: Int)
    /// The outcome of a command with an `id`: `{"type":"result","id":7,"ok":true}`.
    case result(id: Int, ok: Bool, error: String?)

    /// Encodes the message as one line of JSON, with a trailing newline.
    ///
    /// - Returns: The UTF-8 bytes of the line.
    public func line() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Every case holds plain values, so encoding cannot fail.
        var data = (try? encoder.encode(self)) ?? Data()
        data.append(UInt8(ascii: "\n"))
        return data
    }
}

extension BridgeMessage: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, `protocol`, app, keypad, input, id, ok, error
        case selectedWorkspaceID = "selectedWorkspaceId"
    }

    private struct App: Codable, Hashable {
        var version: String
    }

    private enum RadialKeys: String, CodingKey {
        case kind, slot
    }

    /// The `kind` of a radial menu pick, which the keypad's own inputs never use.
    private static let radialKind = "radial"

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "hello":
            self = .hello(
                protocolVersion: try container.decode(Int.self, forKey: .protocol),
                appVersion: try container.decode(App.self, forKey: .app).version,
                keypad: try container.decode(KeypadState.self, forKey: .keypad),
                selectedWorkspaceID: try container.decodeIfPresent(String.self, forKey: .selectedWorkspaceID)
            )
        case "keypad":
            self = .keypad(try container.decode(KeypadState.self, forKey: .keypad))
        case "input":
            let input = try container.nestedContainer(keyedBy: RadialKeys.self, forKey: .input)
            if try input.decode(String.self, forKey: .kind) == Self.radialKind {
                self = .radialPick(slot: try input.decode(Int.self, forKey: .slot))
            } else {
                self = .input(try container.decode(KeypadInput.self, forKey: .input))
            }
        case "result":
            self = .result(
                id: try container.decode(Int.self, forKey: .id),
                ok: try container.decode(Bool.self, forKey: .ok),
                error: try container.decodeIfPresent(String.self, forKey: .error)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown message type \"\(type)\""
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .hello(let version, let appVersion, let keypad, let selectedWorkspaceID):
            try container.encode("hello", forKey: .type)
            try container.encode(version, forKey: .protocol)
            try container.encode(App(version: appVersion), forKey: .app)
            try container.encode(keypad, forKey: .keypad)
            try container.encodeIfPresent(selectedWorkspaceID, forKey: .selectedWorkspaceID)
        case .keypad(let keypad):
            try container.encode("keypad", forKey: .type)
            try container.encode(keypad, forKey: .keypad)
        case .input(let input):
            try container.encode("input", forKey: .type)
            try container.encode(input, forKey: .input)
        case .radialPick(let slot):
            try container.encode("input", forKey: .type)
            var input = container.nestedContainer(keyedBy: RadialKeys.self, forKey: .input)
            try input.encode(Self.radialKind, forKey: .kind)
            try input.encode(slot, forKey: .slot)
        case .result(let id, let ok, let error):
            try container.encode("result", forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encode(ok, forKey: .ok)
            try container.encodeIfPresent(error, forKey: .error)
        }
    }
}

/// A command from a bridge client to the app, with an optional `id`.
///
/// With an `id`, the app answers with ``BridgeMessage/result(id:ok:error:)``.
public struct BridgeCommand: Sendable, Hashable {
    /// What the command asks for.
    public enum Action: Sendable, Hashable {
        /// Sets per-key lights: `{"type":"setKeyLights","lights":[…]}`.
        case setKeyLights([KeyLight])
        /// Sets the zones: `{"type":"setZones","keys":{…},"ambient":{…}}`; a missing zone stays as it is.
        case setZones(keys: ZoneLight?, ambient: ZoneLight?)
        /// Turns every light off: `{"type":"clearLights"}`.
        case clearLights
        /// Asks for a `keypad` message: `{"type":"getState"}`.
        case getState
        /// Opens a `paseo://` link: `{"type":"openURL","url":"paseo://…"}`.
        case openURL(String)
        /// Posts a key combination, after it brings an app to the front if `activate` is true:
        /// `{"type":"sendShortcut","bundleID":"sh.paseo.desktop","shortcut":"cmd+d","activate":true}`.
        case sendShortcut(shortcut: String, bundleID: String?, activate: Bool)
        /// Scrolls the frontmost window of an app by lines, positive down, after it brings the app
        /// to the front if `activate` is true; `fromTop` is the point's height in the window
        /// as a fraction from its top, 0.4 when it is `nil`:
        /// `{"type":"scroll","bundleID":"sh.paseo.desktop","lines":3,"activate":true,"fromTop":0.4}`.
        case scroll(lines: Int, bundleID: String, activate: Bool, fromTop: Double?)
        /// Scrolls the frontmost window of an app to an edge of its content in one scroll,
        /// as ``scroll(lines:bundleID:activate:fromTop:)`` does otherwise:
        /// `{"type":"scroll","bundleID":"sh.paseo.desktop","edge":"bottom","activate":true}`.
        case scrollToEdge(ScrollEdge, bundleID: String, activate: Bool, fromTop: Double?)
        /// Sets the radial menu that the joystick opens, for this client:
        /// `{"type":"setRadialMenu","slots":[{"icon","label","color","enabled"},…],"target":"name"}`.
        case setRadialMenu(RadialMenu)
        /// Clears this client's radial menu, so that the joystick opens none: `{"type":"clearRadialMenu"}`.
        case clearRadialMenu
        /// Stores the selected workspace for the plugin, or clears it with `null`,
        /// so that the next `hello` returns it: `{"type":"setSelection","workspaceId":"…"}`.
        /// The `workspaceId` key is required.
        case setSelection(workspaceID: String?)
    }

    /// The command's identifier, if the client wants a result.
    public var id: Int?
    /// What the command asks for.
    public var action: Action

    /// Creates a command.
    ///
    /// - Parameters:
    ///   - id: The identifier, if the client wants a result.
    ///   - action: What the command asks for.
    public init(id: Int? = nil, _ action: Action) {
        self.id = id
        self.action = action
    }

    /// Encodes the command as one line of JSON, with a trailing newline.
    ///
    /// - Returns: The UTF-8 bytes of the line.
    public func line() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = (try? encoder.encode(self)) ?? Data()
        data.append(UInt8(ascii: "\n"))
        return data
    }
}

extension BridgeCommand: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, id, lights, keys, ambient, url, shortcut, bundleID, activate, lines, edge, fromTop, slots, target
        case workspaceID = "workspaceId"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(Int.self, forKey: .id)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "setKeyLights":
            action = .setKeyLights(try container.decode([KeyLight].self, forKey: .lights))
        case "setZones":
            action = .setZones(
                keys: try container.decodeIfPresent(ZoneLight.self, forKey: .keys),
                ambient: try container.decodeIfPresent(ZoneLight.self, forKey: .ambient)
            )
        case "clearLights":
            action = .clearLights
        case "getState":
            action = .getState
        case "openURL":
            action = .openURL(try container.decode(String.self, forKey: .url))
        case "sendShortcut":
            action = .sendShortcut(
                shortcut: try container.decode(String.self, forKey: .shortcut),
                bundleID: try container.decodeIfPresent(String.self, forKey: .bundleID),
                activate: try container.decodeIfPresent(Bool.self, forKey: .activate) ?? false
            )
        case "scroll":
            let bundleID = try container.decode(String.self, forKey: .bundleID)
            let activate = try container.decodeIfPresent(Bool.self, forKey: .activate) ?? false
            let fromTop = try container.decodeIfPresent(Double.self, forKey: .fromTop)
            switch (
                try container.decodeIfPresent(Int.self, forKey: .lines),
                try container.decodeIfPresent(ScrollEdge.self, forKey: .edge)
            ) {
            case (let lines?, nil):
                action = .scroll(lines: lines, bundleID: bundleID, activate: activate, fromTop: fromTop)
            case (nil, let edge?):
                action = .scrollToEdge(edge, bundleID: bundleID, activate: activate, fromTop: fromTop)
            default:
                throw DecodingError.dataCorruptedError(
                    forKey: .lines,
                    in: container,
                    debugDescription: "A scroll needs exactly one of \"lines\" and \"edge\""
                )
            }
        case "setRadialMenu":
            action = .setRadialMenu(
                RadialMenu(
                    slots: try container.decode([RadialMenuSlot].self, forKey: .slots),
                    target: try container.decodeIfPresent(String.self, forKey: .target),
                    bundleID: try container.decodeIfPresent(String.self, forKey: .bundleID)
                )
            )
        case "clearRadialMenu":
            action = .clearRadialMenu
        case "setSelection":
            // A missing ID is an error rather than a clear, so that a malformed command keeps the selection.
            guard container.contains(.workspaceID) else {
                throw DecodingError.keyNotFound(
                    CodingKeys.workspaceID,
                    DecodingError.Context(codingPath: container.codingPath, debugDescription: "No workspaceId")
                )
            }
            action = .setSelection(workspaceID: try container.decodeIfPresent(String.self, forKey: .workspaceID))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown command type \"\(type)\""
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(id, forKey: .id)
        switch action {
        case .setKeyLights(let lights):
            try container.encode("setKeyLights", forKey: .type)
            try container.encode(lights, forKey: .lights)
        case .setZones(let keys, let ambient):
            try container.encode("setZones", forKey: .type)
            try container.encodeIfPresent(keys, forKey: .keys)
            try container.encodeIfPresent(ambient, forKey: .ambient)
        case .clearLights:
            try container.encode("clearLights", forKey: .type)
        case .getState:
            try container.encode("getState", forKey: .type)
        case .openURL(let url):
            try container.encode("openURL", forKey: .type)
            try container.encode(url, forKey: .url)
        case .sendShortcut(let shortcut, let bundleID, let activate):
            try container.encode("sendShortcut", forKey: .type)
            try container.encode(shortcut, forKey: .shortcut)
            try container.encodeIfPresent(bundleID, forKey: .bundleID)
            try container.encode(activate, forKey: .activate)
        case .scroll(let lines, let bundleID, let activate, let fromTop):
            try container.encode("scroll", forKey: .type)
            try container.encode(lines, forKey: .lines)
            try container.encode(bundleID, forKey: .bundleID)
            try container.encode(activate, forKey: .activate)
            try container.encodeIfPresent(fromTop, forKey: .fromTop)
        case .scrollToEdge(let edge, let bundleID, let activate, let fromTop):
            try container.encode("scroll", forKey: .type)
            try container.encode(edge, forKey: .edge)
            try container.encode(bundleID, forKey: .bundleID)
            try container.encode(activate, forKey: .activate)
            try container.encodeIfPresent(fromTop, forKey: .fromTop)
        case .setRadialMenu(let menu):
            try container.encode("setRadialMenu", forKey: .type)
            try container.encode(menu.slots, forKey: .slots)
            try container.encodeIfPresent(menu.target, forKey: .target)
            try container.encodeIfPresent(menu.bundleID, forKey: .bundleID)
        case .clearRadialMenu:
            try container.encode("clearRadialMenu", forKey: .type)
        case .setSelection(let workspaceID):
            try container.encode("setSelection", forKey: .type)
            try container.encode(workspaceID, forKey: .workspaceID)
        }
    }
}
