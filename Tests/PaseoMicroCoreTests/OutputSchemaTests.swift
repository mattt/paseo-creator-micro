import CreatorMicro
import Foundation
import MCP
@testable import PaseoMicroCore
import Testing

@Suite("Tool output schemas")
struct OutputSchemaTests {
    /// Encodes an output as the tools do and returns it as a value.
    private func encode(_ output: some Encodable) throws -> Value {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try JSONDecoder().decode(Value.self, from: encoder.encode(output))
    }

    private let inputs: [KeypadInput] = [
        .key(KeyInput(key: 3, action: .press)),
        .key(KeyInput(key: 15, action: .release)),
        .dial(.counterclockwise),
        .joystick(JoystickInput(angle: 0.25, distance: 1, sector: 2)),
        .joystick(JoystickInput(angle: 0, distance: 0, sector: -1)),
    ]

    @Test("The state output matches its schema, with and without optional values")
    func stateOutput() throws {
        var lights = DesiredLights()
        lights.set([
            KeyLight(key: 0, color: LightColor(packed: 0xFF2D2D)),
            KeyLight(key: 12, color: LightColor(packed: 0x00a0ff), brightness: 0.4, effect: .breathing, speed: 0.8),
        ])
        lights.zones = ZoneLights(keys: ZoneLight(color: .white), ambient: ZoneLight(color: .black, effect: .rainbow))
        var halfZones = DesiredLights()
        halfZones.zones.ambient = .off
        let connected = KeypadState(
            connected: true,
            transport: "USB",
            firmware: "0.6.3",
            layer: 4,
            battery: 64,
            charging: true,
            inputLayers: [2, 4],
            lightableKeys: [2: Set(0 ... 6)],
            chatGPTRunning: true
        )
        var outputs = [
            KeypadTools.StateOutput(keypad: .disconnected, lights: DesiredLights(), lastInput: nil),
            KeypadTools.StateOutput(keypad: connected, lights: halfZones, lastInput: nil),
        ]
        outputs += inputs.map { KeypadTools.StateOutput(keypad: connected, lights: lights, lastInput: $0) }
        for output in outputs {
            let value = try encode(output)
            #expect(violations(of: value, against: KeypadTools.stateOutputSchema) == [], "\(value)")
        }
        let empty = try encode(outputs[0])
        #expect(empty.objectValue?.keys.contains("lastInput") == false)
        #expect(empty.objectValue?["keypad"]?.objectValue?.keys.contains("layer") == false)
    }

    @Test("The wait output matches its schema, with an input and with null")
    func waitOutput() throws {
        let timedOut = try encode(KeypadTools.WaitOutput(input: nil))
        #expect(timedOut == ["input": .null])
        #expect(violations(of: timedOut, against: KeypadTools.waitOutputSchema) == [])
        for input in inputs {
            let value = try encode(KeypadTools.WaitOutput(input: input))
            #expect(violations(of: value, against: KeypadTools.waitOutputSchema) == [], "\(value)")
        }
    }

    @Test("The schema check finds missing, undeclared, and mistyped values")
    func checkerFindsProblems() {
        let schema: Value = [
            "type": "object",
            "properties": ["count": ["type": "integer"], "name": ["type": ["string", "null"]]],
            "required": ["count"],
        ]
        #expect(violations(of: ["count": 1, "name": .null], against: schema) == [])
        #expect(violations(of: ["name": "a"], against: schema) == ["$: missing count"])
        #expect(violations(of: ["count": 1, "extra": true], against: schema) == ["$: undeclared extra"])
        #expect(violations(of: ["count": 1.5], against: schema) == ["$.count: expected integer"])
        #expect(violations(of: ["count": 1, "name": 2], against: schema) == ["$.name: expected string or null"])

        let either: Value = [
            "oneOf": [
                ["type": "object", "properties": ["kind": ["const": "a"]], "required": ["kind"]],
                ["type": "null"],
            ]
        ]
        #expect(violations(of: ["kind": "a"], against: either) == [])
        #expect(violations(of: .null, against: either) == [])
        #expect(violations(of: ["kind": "b"], against: either) == ["$: matches 0 of oneOf"])
    }
}

/// Checks a value against the parts of JSON Schema that the tools' output schemas use:
/// `type`, `const`, `enum`, `properties`, `required`, `additionalProperties`, `items`, and `oneOf`.
/// A schema with `oneOf` is checked by its branches alone.
///
/// An object member is undeclared unless `properties` names it or `additionalProperties` is a schema.
/// Ranges, patterns, and property names are not checked.
///
/// - Returns: A description of each violation, with its path; empty when the value matches.
func violations(of value: Value, against schema: Value, at path: String = "$") -> [String] {
    guard let schema = schema.objectValue else { return ["\(path): schema is not an object"] }
    if let variants = schema["oneOf"]?.arrayValue {
        let matches = variants.filter { violations(of: value, against: $0, at: path).isEmpty }.count
        // The branch that matches has checked the whole value.
        return matches == 1 ? [] : ["\(path): matches \(matches) of oneOf"]
    }
    if let type = schema["type"] {
        let types = type.arrayValue?.compactMap(\.stringValue) ?? type.stringValue.map { [$0] } ?? []
        if !types.contains(where: { isJSONType(value, $0) }) {
            return ["\(path): expected \(types.joined(separator: " or "))"]
        }
    }
    if let constant = schema["const"], constant != value { return ["\(path): expected \(constant)"] }
    if let choices = schema["enum"]?.arrayValue, !choices.contains(value) { return ["\(path): not in enum"] }
    var found: [String] = []
    if let object = value.objectValue {
        let properties = schema["properties"]?.objectValue ?? [:]
        for name in schema["required"]?.arrayValue?.compactMap(\.stringValue) ?? [] where object[name] == nil {
            found.append("\(path): missing \(name)")
        }
        for (name, member) in object.sorted(by: { $0.key < $1.key }) {
            if let property = properties[name] {
                found += violations(of: member, against: property, at: "\(path).\(name)")
            } else if let additional = schema["additionalProperties"], additional.objectValue != nil {
                found += violations(of: member, against: additional, at: "\(path).\(name)")
            } else {
                found.append("\(path): undeclared \(name)")
            }
        }
    }
    if let array = value.arrayValue, let items = schema["items"] {
        for (index, element) in array.enumerated() {
            found += violations(of: element, against: items, at: "\(path)[\(index)]")
        }
    }
    return found
}

private func isJSONType(_ value: Value, _ type: String) -> Bool {
    switch (type, value) {
    case ("null", .null), ("boolean", .bool), ("string", .string), ("array", .array), ("object", .object):
        true
    case ("integer", .int), ("number", .int), ("number", .double): true
    case ("integer", .double(let number)): number.rounded() == number
    default: false
    }
}
