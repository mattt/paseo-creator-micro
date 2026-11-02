import CreatorMicro
import Foundation
import MCP

/// The MCP tools that let agents read the keypad and control its lights.
///
/// Tools: `get_keypad_state`, `set_key_lights`, `set_zone_lights`, `clear_lights`, and `wait_for_input`.
public struct KeypadTools: Sendable {
    /// The longest wait that `wait_for_input` accepts, in seconds.
    public static let maximumWait: Double = 300

    /// The wait that `wait_for_input` uses when the caller gives none, in seconds.
    public static let defaultWait: Double = 30

    private let session: KeypadSession

    /// Creates the tools.
    ///
    /// - Parameter session: The keypad session that the tools use.
    public init(session: KeypadSession) {
        self.session = session
    }

    /// Registers the tools on an MCP server.
    ///
    /// - Parameter server: The server, before it starts.
    public func register(on server: Server) async {
        await register(on: server) { await $0() }
    }

    /// Registers the tools on an MCP server, with each call's work run by a scope.
    ///
    /// - Parameters:
    ///   - server: The server, before it starts.
    ///   - run: Runs a tool call's work, such as in a task that the caller can cancel.
    func register(
        on server: Server,
        running run: @escaping @Sendable (@escaping @Sendable () async -> CallTool.Result) async -> CallTool.Result
    ) async {
        await server.withMethodHandler(ListTools.self) { _ in
            ListTools.Result(tools: Self.definitions)
        }
        await server.withMethodHandler(CallTool.self) { params in
            await run { await self.call(params.name, arguments: params.arguments ?? [:]) }
        }
    }

    /// The tool definitions, with their input schemas.
    public static let definitions: [Tool] = [
        Tool(
            name: "get_keypad_state",
            description: """
                Returns the Creator Micro 2 keypad's connection, firmware, layer, battery, \
                the lights that the app keeps on it, and the last input. \
                `keypad.chatGPTRunning` says whether the ChatGPT app (Codex) runs; \
                while it does, the app pauses its lighting writes on the ChatGPT layer \
                (`keypad.chatGPTLayer`, the keymap's layer named "ChatGPT", else 4) \
                and repaints its lights every \(KeypadSession.chatGPTRepaintInterval.components.seconds) seconds on other layers, because Codex resets them. \
                `keypad.lightsPaused` says whether writes are paused now, \
                and `keypad.lightingStatus` says why, or that they are not. \
                Per-key lights show and inputs arrive only on the keypad's input layers \
                (`inputLayers`, the layers with vendor codes in its keymap; layer 4 on the stock keymap), \
                and `lightsVisible` says whether the keypad is on one now. \
                On each input layer, only the keys in `lightableKeys` (bound to `AG00`–`AG12`) \
                show their own lights; the others show the key backlight zone.
                """,
            inputSchema: ["type": "object", "properties": [:]],
            annotations: .init(readOnlyHint: true, openWorldHint: false)
        ),
        Tool(
            name: "set_key_lights",
            description: """
                Sets the lights of some keys; other keys keep theirs. \
                Keys run from 0 to 12 in rows of 2, 4, 4, and 3, left to right. \
                A key shows its light only on a layer that lists it in `lightableKeys` \
                (see `get_keypad_state`); keys 0–5 on the stock keymap. \
                The app keeps the lights and sends them again after a reconnect.
                """,
            inputSchema: [
                "type": "object",
                "properties": [
                    "lights": [
                        "type": "array",
                        "minItems": 1,
                        "items": lightSchema(withKey: true),
                    ]
                ],
                "required": ["lights"],
            ],
            annotations: .init(destructiveHint: false, idempotentHint: true, openWorldHint: false)
        ),
        Tool(
            name: "set_zone_lights",
            description: """
                Sets the backlight of keys without their own light ("keys") \
                and the ambient ring ("ambient"). A zone that is left out stays as it is.
                """,
            inputSchema: [
                "type": "object",
                "properties": [
                    "keys": lightSchema(withKey: false),
                    "ambient": lightSchema(withKey: false),
                ],
            ],
            annotations: .init(destructiveHint: false, idempotentHint: true, openWorldHint: false)
        ),
        Tool(
            name: "clear_lights",
            description: "Turns off every key light and both zones, and forgets the lights that the app keeps.",
            inputSchema: ["type": "object", "properties": [:]],
            annotations: .init(destructiveHint: true, idempotentHint: true, openWorldHint: false)
        ),
        Tool(
            name: "wait_for_input",
            description: """
                Waits for the next key, dial, or joystick input on the keypad and returns it, \
                or returns {"input": null} when the timeout passes.
                """,
            inputSchema: [
                "type": "object",
                "properties": [
                    "timeout": [
                        "type": "number",
                        "description":
                            "Seconds to wait, from 0 to \(Int(maximumWait)); the default is \(Int(defaultWait)).",
                        "minimum": 0,
                        "maximum": .double(maximumWait),
                    ]
                ],
            ],
            annotations: .init(readOnlyHint: true, openWorldHint: false)
        ),
    ]

    private static func lightSchema(withKey: Bool) -> Value {
        var properties: [String: Value] = [
            "color": [
                "type": "string", "description": "A hex color such as #FF2D2D.", "pattern": "^#?[0-9A-Fa-f]{6}$",
            ],
            "effect": ["type": "string", "enum": .array(LightEffect.allCases.map { .string($0.name) })],
            "brightness": ["type": "number", "minimum": 0, "maximum": 1],
            "speed": ["type": "number", "minimum": 0, "maximum": 1],
        ]
        var required: [Value] = ["color"]
        if withKey {
            properties["key"] = ["type": "integer", "minimum": 0, "maximum": 12]
            required.insert("key", at: 0)
        }
        return ["type": "object", "properties": .object(properties), "required": .array(required)]
    }

    /// Runs a tool.
    ///
    /// - Parameters:
    ///   - name: The tool's name.
    ///   - arguments: The tool's arguments.
    /// - Returns: The result, with JSON text and structured content,
    ///   or an error result with a message.
    public func call(_ name: String, arguments: [String: Value]) async -> CallTool.Result {
        do {
            switch name {
            case "get_keypad_state":
                return try await stateResult()
            case "set_key_lights":
                struct Arguments: Decodable { var lights: [KeyLight] }
                try await session.setKeyLights(try decode(Arguments.self, from: arguments).lights)
                return try await stateResult()
            case "set_zone_lights":
                let zones = try decode(ZoneLights.self, from: arguments)
                try await session.setZones(keys: zones.keys, ambient: zones.ambient)
                return try await stateResult()
            case "clear_lights":
                try await session.clearLights()
                return try await stateResult()
            case "wait_for_input":
                let seconds = arguments["timeout"].flatMap { Double($0) } ?? Self.defaultWait
                let wait = min(max(seconds, 0), Self.maximumWait)
                let input = await session.nextInput(timeout: .milliseconds(Int(wait * 1000)))
                return try result(WaitOutput(input: input))
            default:
                return CallTool.Result(
                    content: [.text(text: "Unknown tool \(name)", annotations: nil, _meta: nil)],
                    isError: true
                )
            }
        } catch {
            return CallTool.Result(
                content: [.text(text: BridgeServer.describe(error), annotations: nil, _meta: nil)],
                isError: true
            )
        }
    }

    /// The result of `wait_for_input`: `{"input": …}`, with `null` when the wait timed out.
    private struct WaitOutput: Encodable {
        var input: KeypadInput?

        private enum CodingKeys: String, CodingKey { case input }

        func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            // Encode nil as null; synthesized encoding would leave the key out.
            try container.encode(input, forKey: .input)
        }
    }

    private struct StateOutput: Encodable {
        var keypad: KeypadState
        var lights: DesiredLights
        var lastInput: KeypadInput?
    }

    private func stateResult() async throws -> CallTool.Result {
        try result(
            StateOutput(
                keypad: await session.state,
                lights: await session.lights,
                lastInput: await session.lastInput
            )
        )
    }

    private func result(_ output: some Encodable) throws -> CallTool.Result {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(output)
        let structured = try JSONDecoder().decode(Value.self, from: data)
        return CallTool.Result(
            content: [.text(text: String(decoding: data, as: UTF8.self), annotations: nil, _meta: nil)],
            structuredContent: structured as Value?
        )
    }

    private func decode<T: Decodable>(_ type: T.Type, from arguments: [String: Value]) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(arguments))
    }
}
