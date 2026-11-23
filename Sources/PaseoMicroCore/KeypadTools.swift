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

    /// The tool definitions, with their input and output schemas.
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
            annotations: .init(readOnlyHint: true, openWorldHint: false),
            outputSchema: stateOutputSchema
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
            annotations: .init(destructiveHint: false, idempotentHint: true, openWorldHint: false),
            outputSchema: stateOutputSchema
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
            annotations: .init(destructiveHint: false, idempotentHint: true, openWorldHint: false),
            outputSchema: stateOutputSchema
        ),
        Tool(
            name: "clear_lights",
            description: "Turns off every key light and both zones, and forgets the lights that the app keeps.",
            inputSchema: ["type": "object", "properties": [:]],
            annotations: .init(destructiveHint: true, idempotentHint: true, openWorldHint: false),
            outputSchema: stateOutputSchema
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
            annotations: .init(readOnlyHint: true, openWorldHint: false),
            outputSchema: waitOutputSchema
        ),
    ]

    /// The schema of a key or zone light.
    ///
    /// - Parameters:
    ///   - withKey: Whether the light has a `key`.
    ///   - stored: Whether the schema describes a light that the app keeps, in a tool's result,
    ///     which always has every member and an uppercase `#RRGGBB` color,
    ///     rather than a light in a tool's arguments.
    ///   - description: The description of the light, if any.
    private static func lightSchema(withKey: Bool, stored: Bool = false, description: String? = nil) -> Value {
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
        if stored {
            properties["color"] = [
                "type": "string", "description": "The color as #RRGGBB, in uppercase.", "pattern": "^#[0-9A-F]{6}$",
            ]
            if withKey {
                properties["key"] = [
                    "type": "integer", "minimum": 0, "maximum": 12,
                    "description": "The key, from 0 to 12 in rows of 2, 4, 4, and 3, left to right.",
                ]
            }
            required = properties.keys.sorted().map { .string($0) }
        }
        var schema: [String: Value] = [
            "type": "object", "properties": .object(properties), "required": .array(required),
        ]
        if let description { schema["description"] = .string(description) }
        return .object(schema)
    }

    /// The schema of ``StateOutput``, the result of every tool except `wait_for_input`.
    static let stateOutputSchema: Value = [
        "type": "object",
        "properties": [
            "keypad": keypadSchema,
            "lights": [
                "type": "object",
                "description": "The lights that the app keeps and sends again after a reconnect.",
                "properties": [
                    "keys": [
                        "type": "array",
                        "description": "The per-key lights, by key in ascending order.",
                        "items": lightSchema(withKey: true, stored: true),
                    ],
                    "zones": [
                        "type": "object",
                        "description": "The zone lights; a zone that is not set is absent.",
                        "properties": [
                            "keys": lightSchema(
                                withKey: false,
                                stored: true,
                                description: "The backlight of keys that do not show their own light."
                            ),
                            "ambient": lightSchema(withKey: false, stored: true, description: "The ambient ring."),
                        ],
                    ],
                ],
                "required": ["keys", "zones"],
            ],
            "lastInput": inputSchema(
                description: "The last key, dial, or joystick input; absent until the first input.",
                nullable: false
            ),
        ],
        "required": ["keypad", "lights"],
    ]

    /// The schema of ``WaitOutput``, the result of `wait_for_input`.
    static let waitOutputSchema: Value = [
        "type": "object",
        "properties": [
            "input": inputSchema(
                description: "The input, or null when the timeout passed first.",
                nullable: true
            )
        ],
        "required": ["input"],
    ]

    /// The schema of ``KeypadState``.
    private static let keypadSchema: Value = [
        "type": "object",
        "description": "What the app knows about the keypad. A value that is not yet known is absent.",
        "properties": [
            "connected": ["type": "boolean", "description": "Whether a keypad is connected."],
            "transport": [
                "type": "string",
                "description": "The connection, such as USB or Emulated; absent when disconnected.",
            ],
            "firmware": ["type": "string", "description": "The firmware version, such as 0.6.3."],
            "layer": [
                "type": "integer", "minimum": 1, "description": "The active layer, counted from 1.",
            ],
            "battery": [
                "type": "integer", "minimum": 0, "maximum": 100, "description": "The battery charge, in percent.",
            ],
            "charging": ["type": "boolean", "description": "Whether the battery is charging."],
            "inputLayers": [
                "type": "array",
                "description": """
                The layers, in ascending order, whose inputs reach the app and whose keys show per-key lights.
                """,
                "items": ["type": "integer", "minimum": 1],
            ],
            "lightableKeys": [
                "type": "object",
                "description": """
                The keys, from 0 to 12, that show their own lights on each input layer, \
                by layer number. Other keys show the key backlight zone.
                """,
                "propertyNames": ["pattern": "^[0-9]+$"],
                "additionalProperties": [
                    "type": "array",
                    "items": ["type": "integer", "minimum": 0, "maximum": 12],
                ],
            ],
            "lightsVisible": [
                "type": "boolean",
                "description": "Whether a keypad is connected and its active layer is an input layer.",
            ],
            "chatGPTLayer": [
                "type": "integer", "minimum": 1,
                "description": #"The layer that Codex drives: the keymap's layer named "ChatGPT", else 4."#,
            ],
            "chatGPTRunning": [
                "type": "boolean",
                "description": "Whether the ChatGPT app (Codex) runs and can reach the keypad.",
            ],
            "lightsPaused": [
                "type": "boolean", "description": "Whether the app pauses its lighting writes now.",
            ],
            "lightingStatus": [
                "type": "string", "description": "Why lighting writes are paused, or that they are not.",
            ],
        ],
        "required": [
            "connected", "inputLayers", "lightableKeys", "lightsVisible", "chatGPTLayer", "chatGPTRunning",
            "lightsPaused", "lightingStatus",
        ],
    ]

    /// The schema of a ``KeypadInput``: one of a key, dial, or joystick object, told apart by `kind`.
    ///
    /// - Parameters:
    ///   - description: The description of the value.
    ///   - nullable: Whether the value can be `null`.
    private static func inputSchema(description: String, nullable: Bool) -> Value {
        var variants: [Value] = [
            [
                "type": "object",
                "properties": [
                    "kind": ["type": "string", "const": "key"],
                    "key": [
                        "type": "integer", "minimum": 0, "maximum": 19,
                        "description": """
                        The key: 0 to 12 for the physical keys, in rows of 2, 4, 4, and 3, left to right, \
                        or 13 to 19 for the codes AG13 to AG19, which a keymap can bind to other controls.
                        """,
                    ],
                    "code": [
                        "type": "string",
                        "description": "The firmware's code for the key, such as AG03 or ACT10.",
                    ],
                    "action": [
                        "type": "string",
                        "enum": .array(KeyAction.allCases.map { .string($0.rawValue) }),
                    ],
                ],
                "required": ["kind", "key", "code", "action"],
            ],
            [
                "type": "object",
                "properties": [
                    "kind": ["type": "string", "const": "dial"],
                    "action": [
                        "type": "string",
                        "description": "One step clockwise or counterclockwise, or a press or release of the dial.",
                        "enum": .array(DialAction.allCases.map { .string($0.rawValue) }),
                    ],
                ],
                "required": ["kind", "action"],
            ],
            [
                "type": "object",
                "properties": [
                    "kind": ["type": "string", "const": "joystick"],
                    "angle": [
                        "type": "number", "minimum": 0, "maximum": 1,
                        "description": """
                        The direction, as a fraction of a turn counterclockwise from east: \
                        up is 0.25, west is 0.5, and down is 0.75.
                        """,
                    ],
                    "distance": [
                        "type": "number", "minimum": 0, "maximum": 1,
                        "description": "The distance from the center, from 0 to 1.",
                    ],
                    "sector": [
                        "type": "integer", "minimum": -1, "maximum": 7,
                        "description": "The sector, from 0 to 7, or -1 when the joystick is at rest.",
                    ],
                ],
                "required": ["kind", "angle", "distance", "sector"],
            ],
        ]
        if nullable { variants.append(["type": "null"]) }
        return ["description": .string(description), "oneOf": .array(variants)]
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
    struct WaitOutput: Encodable {
        var input: KeypadInput?

        private enum CodingKeys: String, CodingKey { case input }

        func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            // Encode nil as null; synthesized encoding would leave the key out.
            try container.encode(input, forKey: .input)
        }
    }

    /// The result of every tool except `wait_for_input`: the keypad's state, the lights that the app keeps,
    /// and the last input, which is absent until the first input.
    struct StateOutput: Encodable {
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
