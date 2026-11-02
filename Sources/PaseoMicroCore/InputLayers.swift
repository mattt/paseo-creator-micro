import CreatorMicro
import Foundation

/// Finds the keypad layers whose inputs reach the app, from the keypad's `keymap.json`.
///
/// A layer is an input layer when its key map, its encoders, or its joystick sectors
/// contain a vendor code (`KV_OAI_…`): the keypad sends those as `v.oai.hid` notifications,
/// and its per-key lights show only on such layers.
/// The stock keymap has one: layer 4, "ChatGPT".
///
/// On an input layer, the firmware lights a key only when the layer binds it
/// to a `KV_OAI_AG*` code; a key bound to `KV_OAI_ACT*` shows the key backlight zone instead.
/// ``lightableKeys(keymap:)`` reports those keys for each input layer.
///
/// The keymap also names the layer that Codex drives, "ChatGPT";
/// ``chatGPTLayer(keymap:)`` finds it.
public enum InputLayers {
    /// The layers to assume when the keymap cannot be read: the stock "ChatGPT" layer.
    public static let fallback: Set<Int> = [4]

    /// The keys that show per-key lights on a layer whose keymap is unknown:
    /// keys 0–5, which the stock "ChatGPT" layer binds to `KV_OAI_AG00`–`KV_OAI_AG05`.
    public static let stockLightableKeys: Set<Int> = Set(0 ... 5)

    /// The lightable keys to assume when the keymap cannot be read:
    /// ``stockLightableKeys`` on each layer of ``fallback``.
    public static let fallbackLightableKeys: [Int: Set<Int>] = [4: stockLightableKeys]

    /// The prefix of the vendor codes that the keypad reports to the app.
    public static let vendorCodePrefix = "KV_OAI_"

    /// The file that holds the keypad's layers.
    public static let keymapFile = "keymap.json"

    /// The name of the layer that Codex drives: layer 4 on the stock keymap.
    public static let chatGPTLayerName = "ChatGPT"

    /// The ChatGPT layer to assume when no layer has ``chatGPTLayerName`` or the keymap cannot be read.
    public static let fallbackChatGPTLayer = 4

    /// Finds the input layers in a keymap.
    ///
    /// The layers come from the profile whose `id` is `activeProfileId`, else from the first profile.
    /// Each layer's codes are in its `layout` (or in the layer itself, if it has no `layout`):
    /// `keymap` (rows of codes), `encoders` (lists of codes), and `joystick.sectors[].k`.
    ///
    /// - Parameter keymap: The parsed contents of `keymap.json`.
    /// - Returns: The 1-based indexes of the layers with a vendor code, which may be empty,
    ///   or `nil` if the keymap has no profile with layers.
    public static func parse(keymap: JSONValue) -> Set<Int>? {
        lightableKeys(keymap: keymap).map { Set($0.keys) }
    }

    /// Finds the input layers in a keymap, with the keys that show per-key lights on each.
    ///
    /// A key shows its light on a layer when the layer's `keymap` rows bind it
    /// to `KV_OAI_AG00`–`KV_OAI_AG12`; the code's number is the key's index.
    /// The layers are those of ``parse(keymap:)``.
    ///
    /// - Parameter keymap: The parsed contents of `keymap.json`.
    /// - Returns: Each input layer's 1-based index with its lightable keys, which may be empty,
    ///   or `nil` if the keymap has no profile with layers.
    public static func lightableKeys(keymap: JSONValue) -> [Int: Set<Int>]? {
        guard let layers = layers(in: keymap) else { return nil }
        var found: [Int: Set<Int>] = [:]
        for (index, layer) in layers.enumerated() {
            let layout = layer["layout"] ?? layer
            let sectors = layout["joystick"]?["sectors"]?.arrayValue?.compactMap { $0["k"] } ?? []
            let codes = [layout["keymap"], layout["encoders"]].compactMap { $0 } + sectors
            guard codes.contains(where: containsVendorCode) else { continue }
            found[index + 1] = Set(strings(in: layout["keymap"]).compactMap(lightableKey))
        }
        return found
    }

    /// Finds the layer named ``chatGPTLayerName`` in a keymap, ignoring case.
    ///
    /// The layers come from the same profile as in ``parse(keymap:)``.
    ///
    /// - Parameter keymap: The parsed contents of `keymap.json`.
    /// - Returns: The 1-based index of the first such layer, or `nil` if no layer has the name.
    public static func chatGPTLayer(keymap: JSONValue) -> Int? {
        guard let layers = layers(in: keymap) else { return nil }
        let index = layers.firstIndex {
            $0["name"]?.stringValue?.caseInsensitiveCompare(chatGPTLayerName) == .orderedSame
        }
        return index.map { $0 + 1 }
    }

    /// Reads the input layers from the reply to `fs.read` for ``keymapFile``.
    ///
    /// - Parameter reply: The reply, `{"data": "<the file's text>"}`.
    /// - Returns: The input layers, or `nil` if the reply holds no keymap that ``parse(keymap:)`` reads.
    public static func parse(readReply reply: JSONValue) -> Set<Int>? {
        lightableKeys(readReply: reply).map { Set($0.keys) }
    }

    /// Reads the input layers and their lightable keys from the reply to `fs.read` for ``keymapFile``.
    ///
    /// - Parameter reply: The reply, `{"data": "<the file's text>"}`.
    /// - Returns: The layers and keys, or `nil` if the reply holds no keymap
    ///   that ``lightableKeys(keymap:)`` reads.
    public static func lightableKeys(readReply reply: JSONValue) -> [Int: Set<Int>]? {
        keymap(readReply: reply).flatMap(lightableKeys(keymap:))
    }

    /// Parses the keymap in the reply to `fs.read` for ``keymapFile``.
    ///
    /// - Parameter reply: The reply, `{"data": "<the file's text>"}`.
    /// - Returns: The parsed keymap, or `nil` if the reply holds no JSON text.
    public static func keymap(readReply reply: JSONValue) -> JSONValue? {
        guard let text = reply["data"]?.stringValue else { return nil }
        return try? JSONValue(parsing: Data(text.utf8))
    }

    /// The layers of the profile whose `id` is `activeProfileId`, else of the first profile.
    private static func layers(in keymap: JSONValue) -> [JSONValue]? {
        guard let profiles = keymap["profiles"]?.arrayValue, !profiles.isEmpty else { return nil }
        let active = keymap["activeProfileId"]?.intValue
        let profile = profiles.first { active != nil && $0["id"]?.intValue == active } ?? profiles[0]
        return profile["layers"]?.arrayValue
    }

    /// The key that a keymap code lights: 0 to 12 for `KV_OAI_AG00` to `KV_OAI_AG12`, else `nil`.
    static func lightableKey(_ code: String) -> Int? {
        guard code.hasPrefix(vendorCodePrefix + "AG"),
            let input = KeyInput(code: String(code.dropFirst(vendorCodePrefix.count)), act: 1),
            input.key < KeyInput.count
        else { return nil }
        return input.key
    }

    private static func strings(in value: JSONValue?) -> [String] {
        guard let value else { return [] }
        if let text = value.stringValue { return [text] }
        return value.arrayValue?.flatMap { strings(in: $0) } ?? []
    }

    private static func containsVendorCode(_ value: JSONValue) -> Bool {
        if let text = value.stringValue { return text.hasPrefix(vendorCodePrefix) }
        return value.arrayValue?.contains(where: containsVendorCode) ?? false
    }
}
