import Foundation

/// A JSON-RPC request to the keypad.
///
/// The firmware expects `{"method", "params", "id"}` with an `id` from 1 to 999,
/// and no `"jsonrpc"` member.
public struct RPCRequest: Sendable, Hashable {
    /// The method name, such as `sys.version`.
    public var method: String
    /// The parameters, or `nil` to omit them.
    public var params: JSONValue?
    /// The request identifier, from 1 to 999.
    public var id: Int

    /// Creates a request.
    ///
    /// - Parameters:
    ///   - method: The method name.
    ///   - params: The parameters, or `nil` to omit them.
    ///   - id: The request identifier, from 1 to 999.
    public init(method: String, params: JSONValue? = nil, id: Int) {
        self.method = method
        self.params = params
        self.id = id
    }

    /// The request as a JSON object.
    public var json: JSONValue {
        var object: [String: JSONValue] = ["method": .string(method), "id": .number(Double(id))]
        if let params { object["params"] = params }
        return .object(object)
    }

    /// Parses a request from the JSON that a host sent.
    ///
    /// - Parameter value: A JSON object with `method` and `id`.
    /// - Returns: The request, or `nil` if the object is not a request.
    public init?(json value: JSONValue) {
        guard let method = value["method"]?.stringValue, let id = value["id"]?.intValue else { return nil }
        self.init(method: method, params: value["params"], id: id)
    }
}

/// A message from the keypad: a reply to a request, or a notification.
public enum RPCMessage: Sendable, Hashable {
    /// A reply to the request with the given identifier.
    ///
    /// - Parameters:
    ///   - id: The identifier of the request.
    ///   - result: The `result` member, if any.
    ///   - error: The `error` member, if any.
    case reply(id: Int, result: JSONValue?, error: JSONValue?)
    /// An unsolicited event, sent as `{"m", "p"}`.
    ///
    /// - Parameters:
    ///   - method: The `m` member, such as `v.oai.hid`.
    ///   - params: The `p` member, if any.
    case notification(method: String, params: JSONValue?)

    /// Parses a message from the UTF-8 bytes of one JSON object.
    ///
    /// - Parameter bytes: The bytes of one object from ``MessageReassembler``.
    /// - Returns: The message, or `nil` if the bytes are not JSON
    ///   or the object is neither a reply nor a notification.
    public init?(bytes: some Collection<UInt8>) {
        guard let value = try? JSONValue(parsing: Data(bytes)) else { return nil }
        self.init(json: value)
    }

    /// Parses a message from a JSON object.
    ///
    /// - Parameter value: The JSON object.
    /// - Returns: The message, or `nil` if the object is neither a reply nor a notification.
    public init?(json value: JSONValue) {
        if let id = value["id"]?.intValue {
            self = .reply(id: id, result: value["result"], error: value["error"])
        } else if let method = value["m"]?.stringValue {
            self = .notification(method: method, params: value["p"])
        } else {
            return nil
        }
    }

    /// The message as a JSON object, as the firmware sends it.
    public var json: JSONValue {
        switch self {
        case .reply(let id, let result, let error):
            var object: [String: JSONValue] = ["id": .number(Double(id))]
            if let result { object["result"] = result }
            if let error { object["error"] = error }
            return .object(object)
        case .notification(let method, let params):
            var object: [String: JSONValue] = ["m": .string(method)]
            if let params { object["p"] = params }
            return .object(object)
        }
    }
}

/// Hands out request identifiers from 1 to 999, the range that the firmware accepts.
///
/// Identifiers wrap from 999 back to 1,
/// and skip identifiers that are still in use.
public struct RequestIDGenerator: Sendable {
    /// The lowest identifier.
    public static let lowest = 1
    /// The highest identifier; the firmware rejects 1000 and more.
    public static let highest = 999

    private var last: Int

    /// Creates a generator.
    ///
    /// - Parameter first: The first identifier to hand out.
    ///   A random start makes a clash with another program's identifiers less likely.
    public init(first: Int = Int.random(in: 100 ..< 900)) {
        let clamped = min(max(first, Self.lowest), Self.highest)
        last = clamped == Self.lowest ? Self.highest : clamped - 1
    }

    /// Returns the next identifier that is not in use.
    ///
    /// - Parameter inUse: The identifiers of requests that still wait for replies.
    /// - Returns: An identifier from 1 to 999, or `nil` if all 999 are in use.
    public mutating func next(excluding inUse: Set<Int> = []) -> Int? {
        for _ in Self.lowest ... Self.highest {
            last = last >= Self.highest ? Self.lowest : last + 1
            if !inUse.contains(last) { return last }
        }
        return nil
    }
}

/// The JSON-RPC methods that the keypad answers.
public enum KeypadMethod {
    /// Returns `{"version"}`.
    public static let version = "sys.version"
    /// Returns battery, charging, layer, profile, and version.
    public static let status = "device.status"
    /// Sets per-key lights; params are a bare array of key lights.
    public static let keyLights = "v.oai.thstatus"
    /// Sets the `keys` and `ambient` lighting zones.
    public static let zones = "v.oai.rgbcfg"
    /// Previews board lighting without saving it.
    public static let lightsPreview = "lights.preview"
    /// Tells the keypad which app has focus.
    public static let focusedApp = "host.focused_app"
    /// Lists the keypad's files.
    public static let listFiles = "fs.list"
    /// Reads a file from the keypad.
    public static let readFile = "fs.read"

    /// Methods that write or delete the keypad's files.
    ///
    /// A corrupt keymap can leave the keypad unusable until it is reflashed,
    /// so ``KeypadClient`` refuses these methods and every other `fs.` method
    /// except ``listFiles`` and ``readFile``.
    public static let fileWrites: Set<String> = ["fs.write", "fs.writebin", "fs.delete"]

    /// Returns whether the client may send a method.
    ///
    /// - Parameter method: A method name.
    /// - Returns: `false` for every `fs.` method except ``listFiles`` and ``readFile``.
    public static func isAllowed(_ method: String) -> Bool {
        guard method.hasPrefix("fs.") else { return true }
        return method == listFiles || method == readFile
    }
}
