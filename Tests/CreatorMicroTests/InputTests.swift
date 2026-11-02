import CreatorMicro
import Foundation
import Testing

@Suite("Input parsing")
struct InputTests {
    @Test("Agent keys AG00 to AG05 are keys 0 to 5", arguments: 0 ..< 6)
    func agentKeys(key: Int) {
        let code = String(format: "AG%02d", key)
        #expect(
            KeypadInput(method: "v.oai.hid", params: ["k": .string(code), "act": 1])
                == .key(KeyInput(key: key, action: .press))
        )
        #expect(
            KeypadInput(method: "v.oai.hid", params: ["k": .string(code), "act": 0])
                == .key(KeyInput(key: key, action: .release))
        )
    }

    @Test("Action keys ACT06 to ACT12 are keys 6 to 12", arguments: 6 ..< 13)
    func actionKeys(key: Int) throws {
        let code = String(format: "ACT%02d", key)
        let input = try #require(KeypadInput(method: "v.oai.hid", params: ["k": .string(code), "act": 1]))
        #expect(input == .key(KeyInput(key: key, action: .press)))
        guard case .key(let keyInput) = input else { return }
        #expect(keyInput.code == code)
    }

    @Test("AG06 to AG12, which light keys 6 to 12, are keys 6 to 12 as ACT06 to ACT12 are", arguments: 6 ..< 13)
    func lightableActionKeys(key: Int) throws {
        let code = String(format: "AG%02d", key)
        for (act, action) in [(1, KeyAction.press), (0, .release)] {
            let input = try #require(
                KeypadInput(method: "v.oai.hid", params: ["k": .string(code), "act": .number(Double(act))])
            )
            guard case .key(let keyInput) = input else {
                Issue.record("Expected a key, not \(input)")
                return
            }
            #expect(keyInput.key == key)
            #expect(keyInput.action == action)
            #expect(keyInput.code == code)
            let line = try String(decoding: JSONEncoder().encode(input), as: UTF8.self)
            #expect(line.contains(#""key":\#(key)"#))
            #expect(line.contains(#""code":"\#(code)""#))
        }
    }

    @Test("Dial steps follow the keymap slots, and the dial presses")
    func dial() {
        #expect(KeypadInput(method: "v.oai.hid", params: ["k": "ENC_CC", "act": 2]) == .dial(.clockwise))
        #expect(KeypadInput(method: "v.oai.hid", params: ["k": "ENC_CW", "act": 2]) == .dial(.counterclockwise))
        #expect(KeypadInput(method: "v.oai.hid", params: ["k": "ENC_CLK", "act": 1]) == .dial(.press))
        #expect(KeypadInput(method: "v.oai.hid", params: ["k": "ENC_CLK", "act": 0]) == .dial(.release))
    }

    @Test("The firmware's joystick angle is mirrored: up is 0.25 and down is 0.75")
    func joystickAngleConvention() {
        // Pushes up, left, down, and right on layer 2, recorded on 2026-10-28.
        let pushes: [(firmware: Double, expected: Double)] = [(0.755, 0.245), (0.494, 0.506), (0.244, 0.756), (0, 0)]
        for push in pushes {
            let input = KeypadInput(method: "kb.radial", params: ["a": .number(push.firmware), "d": 1, "s": 0])
            guard case .joystick(let joystick) = input else {
                Issue.record("Expected a joystick input")
                return
            }
            #expect(abs(joystick.angle - push.expected) < 0.000_001)
            #expect(abs(JoystickInput.firmwareAngle(joystick.angle) - push.firmware) < 0.000_001)
        }
    }

    @Test("The joystick parses from kb.radial and the older v.oai.rad")
    func joystick() {
        // The firmware's 0.24 is a push down (checked on the keypad on 2026-10-28), which is 0.76 here.
        let params: JSONValue = ["a": 0.24, "d": 1, "s": 0, "l": 0, "o": 2, "p": 0]
        let expected = KeypadInput.joystick(JoystickInput(angle: 0.76, distance: 1, sector: 0))
        #expect(KeypadInput(method: "kb.radial", params: params) == expected)
        #expect(KeypadInput(method: "v.oai.rad", params: params) == expected)
        let rest = KeypadInput(method: "kb.radial", params: ["a": 0, "d": 0, "s": -1])
        guard case .joystick(let joystick) = rest else {
            Issue.record("Expected a joystick input")
            return
        }
        #expect(joystick.isAtRest)
    }

    @Test(
        "Unknown codes, actions, and methods are not inputs",
        arguments: [
            ("v.oai.hid", ["k": "AG20", "act": 1]),
            ("v.oai.hid", ["k": "ACT13", "act": 1]),
            ("v.oai.hid", ["k": "KC_A", "act": 1]),
            ("v.oai.hid", ["k": "AG00", "act": 2]),
            ("v.oai.hid", ["k": "ENC_CC", "act": 1]),
            ("v.oai.hid", ["k": "AG-1", "act": 1]),
            ("v.oai.hid", ["k": "AG", "act": 1]),
            ("v.oai.hid", ["act": 1]),
            ("kb.radial", ["a": 0.5]),
            ("host.focused_app", ["app": "x"]),
        ] as [(String, JSONValue)]
    )
    func notInputs(method: String, params: JSONValue) {
        #expect(KeypadInput(method: method, params: params) == nil)
    }

    @Test("Inputs encode in the bridge's form")
    func bridgeForm() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        func json(_ input: KeypadInput) throws -> String {
            String(decoding: try encoder.encode(input), as: UTF8.self)
        }
        #expect(
            try json(.key(KeyInput(key: 3, action: .press)))
                == #"{"action":"press","code":"AG03","key":3,"kind":"key"}"#
        )
        #expect(try json(.dial(.clockwise)) == #"{"action":"clockwise","kind":"dial"}"#)
        #expect(
            try json(.joystick(JoystickInput(angle: 0.25, distance: 1, sector: 0)))
                == #"{"angle":0.25,"distance":1,"kind":"joystick","sector":0}"#
        )
    }

    @Test(
        "Inputs survive the notification and bridge round trips",
        arguments: [
            KeypadInput.key(KeyInput(key: 0, action: .press)),
            .key(KeyInput(key: 12, action: .release)),
            .dial(.clockwise), .dial(.counterclockwise), .dial(.press), .dial(.release),
            .joystick(JoystickInput(angle: 0.75, distance: 0.5, sector: 6)),
        ]
    )
    func roundTrips(input: KeypadInput) throws {
        guard case .notification(let method, let params) = input.notification else {
            Issue.record("Expected a notification")
            return
        }
        #expect(KeypadInput(method: method, params: params) == input)
        let decoded = try JSONDecoder().decode(KeypadInput.self, from: JSONEncoder().encode(input))
        #expect(decoded == input)
    }

    @Test("AG13 to AG19, which a keymap can bind to the joystick, are unlit keys 13 to 19", arguments: 13 ... 19)
    func unlitKeys(key: Int) throws {
        let code = "AG\(key)"
        let input = KeypadInput(method: "v.oai.hid", params: ["k": .string(code), "act": 1])
        #expect(input == .key(KeyInput(key: key, action: .press)))
        #expect(KeyInput.code(for: key) == code)
        #expect(KeyInput.unlitKeys.contains(key))
        let released = try #require(KeypadInput(method: "v.oai.hid", params: ["k": .string(code), "act": 0]))
        #expect(released == .key(KeyInput(key: key, action: .release)))
        let line = try String(decoding: JSONEncoder().encode(released), as: UTF8.self)
        #expect(line.contains(#""code":"\#(code)""#))
        #expect(try JSONDecoder().decode(KeypadInput.self, from: Data(line.utf8)) == released)
    }

    @Test("Key codes follow the stock layer 4 keymap")
    func codes() {
        #expect(
            (0 ..< 13).map(KeyInput.code(for:)) == [
                "AG00", "AG01", "AG02", "AG03", "AG04", "AG05",
                "ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12",
            ]
        )
    }
}
