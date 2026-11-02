import CreatorMicro
import Foundation
@testable import PaseoMicroCore
import Testing

/// A keymap like the stock one, with layer 2 given the vendor codes, `AG06` on key 6,
/// and a radial joystick whose cardinal sectors send `AG15`–`AG18`.
let paseoLayer2Keymap = #"""
    {"version":1,"activeProfileId":0,"profiles":[{"id":0,"name":"Default","layers":[
    {"id":0,"name":"Layer 1","layout":{"keymap":[["KC_A","KC_B"]],"encoders":[["KC_VOLU","KC_VOLD","KC_MPLY"]],
    "joystick":{"type":"RADIAL","sectors":[{"k":"KC_P1","a1":0.1875,"a2":0.3125}]}}},
    {"id":1,"name":"Layer 2","layout":{"keymap":[["KV_OAI_AG00","KV_OAI_AG01"],["KV_OAI_AG06","KV_OAI_ACT07"]],
    "encoders":[["KV_OAI_ENC_CC","KV_OAI_ENC_CW","KV_OAI_ENC_CLK"]],
    "joystick":{"type":"RADIAL","sectors":[{"k":"KV_OAI_AG15","a1":0.1875,"a2":0.3125},
    {"k":"KC_NONE","a1":0.3125,"a2":0.4375},{"k":"KV_OAI_AG16","a1":0.4375,"a2":0.5625}]}}},
    {"id":2,"name":"Layer 3","layout":{"keymap":[["KC_NONE"]],"joystick":{"type":"JOYSTICK","sectors":[]}}},
    {"id":3,"name":"ChatGPT","layout":{"keymap":[["KV_OAI_AG00"]],"joystick":{"type":"VENDOR","sectors":[]}}}]}]}
    """#

@Suite("Input layers")
struct InputLayersTests {
    private func parse(_ text: String) throws -> Set<Int>? {
        InputLayers.parse(keymap: try JSONValue(parsing: Data(text.utf8)))
    }

    @Test("Finds the layers whose key map, encoders, or joystick sectors have vendor codes")
    func parsesLayers() throws {
        #expect(try parse(EmulatedKeypad.stockKeymap) == [4])
        #expect(try parse(paseoLayer2Keymap) == [2, 4])
        let encodersOnly = #"{"profiles":[{"layers":[{"layout":{"encoders":[["KV_OAI_ENC_CC"]]}}]}]}"#
        #expect(try parse(encodersOnly) == [1])
        let sectorsOnly =
            #"{"profiles":[{"layers":[{},{"layout":{"joystick":{"sectors":[{"k":"KV_OAI_AG15"}]}}}]}]}"#
        #expect(try parse(sectorsOnly) == [2])
        let withoutLayout = #"{"profiles":[{"layers":[{"keymap":[["KV_OAI_AG00"]]},{"keymap":[["KC_A"]]}]}]}"#
        #expect(try parse(withoutLayout) == [1])
    }

    @Test("Finds the keys that each input layer lights: its AG00 to AG12 codes")
    func lightableKeys() throws {
        let parse = { (text: String) in InputLayers.lightableKeys(keymap: try JSONValue(parsing: Data(text.utf8))) }
        #expect(try parse(paseoLayer2Keymap) == [2: [0, 1, 6], 4: [0]])
        #expect(try parse(EmulatedKeypad.stockKeymap) == [4: Set(0 ... 5)])
        // Encoder and joystick codes, ACT codes, and AG13 and above light no key.
        let other = #"""
            {"profiles":[{"layers":[{"layout":{"keymap":[["KV_OAI_ACT06","KV_OAI_AG13","KV_OAI_AG12","KV_OAI_AGX"]],
            "encoders":[["KV_OAI_ENC_CC"]],"joystick":{"sectors":[{"k":"KV_OAI_AG15"}]}}},
            {"layout":{"encoders":[["KV_OAI_ENC_CC"]]}}]}]}
            """#
        #expect(try parse(other) == [1: [12], 2: []])
        #expect(InputLayers.lightableKey("KV_OAI_AG06") == 6)
        #expect(InputLayers.lightableKey("AG06") == nil)
        #expect(InputLayers.lightableKey("KV_OAI_AG19") == nil)
    }

    @Test("Reads the active profile, and ignores vendor codes outside the layout's inputs")
    func activeProfile() throws {
        let keymap = #"""
            {"activeProfileId":7,"profiles":[
            {"id":0,"layers":[{"layout":{"keymap":[["KV_OAI_AG00"]]}}]},
            {"id":7,"layers":[{"layout":{"keymap":[["KC_A"]]},"name":"KV_OAI_name"},{"layout":{"keymap":[["KV_OAI_AG00"]]}}]}]}
            """#
        #expect(try parse(keymap) == [2])
    }

    @Test("Reports no input layers for a keymap without vendor codes, and nil for one without layers")
    func emptyAndInvalid() throws {
        #expect(try parse(#"{"profiles":[{"layers":[{"layout":{"keymap":[["KC_A"]]}}]}]}"#) == [])
        #expect(try parse(#"{"profiles":[]}"#) == nil)
        #expect(try parse(#"{"profiles":[{"name":"x"}]}"#) == nil)
        #expect(try parse("[]") == nil)
        #expect(InputLayers.parse(readReply: ["ok": 1]) == nil)
        #expect(InputLayers.parse(readReply: ["data": "not json"]) == nil)
        #expect(InputLayers.parse(readReply: ["data": .string(EmulatedKeypad.stockKeymap)]) == [4])
    }

    @Test("A state shows lights on its input layers and describes its layer for the menu")
    func state() {
        let layer2 = KeypadState(connected: true, layer: 2, inputLayers: [4, 2])
        #expect(layer2.inputLayers == [2, 4])
        #expect(layer2.lightsVisible)
        #expect(layer2.layerDescription == "2 (Paseo layer)")
        #expect(layer2.inputLayerList == "layer 2 or 4")
        let layer1 = KeypadState(connected: true, layer: 1, inputLayers: [2, 4])
        #expect(!layer1.lightsVisible)
        #expect(layer1.layerDescription == "1")
        #expect(KeypadState(connected: true, layer: 4).inputLayerList == "layer 4")
        #expect(KeypadState(connected: true, layer: 4, inputLayers: []).inputLayerList == "none in the keymap")
        #expect(KeypadState(connected: true, inputLayers: [1, 2, 4]).inputLayerList == "layer 1, 2 or 4")
        #expect(!KeypadState(connected: false, layer: 4).lightsVisible)
        #expect(KeypadState.disconnected.layerDescription == "—")
    }

    @Test("A state encodes its input layers, and one without them decodes with layer 4")
    func coding() throws {
        let state = KeypadState(connected: true, layer: 2, inputLayers: [2, 4])
        let data = try JSONEncoder().encode(state)
        #expect(String(decoding: data, as: UTF8.self).contains(#""inputLayers":[2,4]"#))
        #expect(try JSONDecoder().decode(KeypadState.self, from: data) == state)
        let old = #"{"connected":true,"layer":4,"lightsVisible":true}"#
        let decoded = try JSONDecoder().decode(KeypadState.self, from: Data(old.utf8))
        #expect(decoded.inputLayers == [4])
        #expect(decoded.lightableKeys == [4: [0, 1, 2, 3, 4, 5]])
        #expect(decoded.lightsVisible)
    }

    @Test("A state encodes the lightable keys of each input layer, keys 0 to 5 by default")
    func lightableKeysCoding() throws {
        let state = KeypadState(connected: true, layer: 2, inputLayers: [2, 4], lightableKeys: [2: [6, 0], 9: [1]])
        #expect(state.lightableKeys == [2: [0, 6], 4: [0, 1, 2, 3, 4, 5]])
        #expect(state.litKeysOnLayer == [0, 6])
        #expect(KeypadState(connected: true, layer: 1, inputLayers: [2, 4]).litKeysOnLayer.isEmpty)
        let data = try JSONEncoder().encode(state)
        #expect(String(decoding: data, as: UTF8.self).contains(#""2":[0,6]"#))
        #expect(try JSONDecoder().decode(KeypadState.self, from: data) == state)
    }

    @Test("The session reads the keymap when the keypad connects and shows lights on its Paseo layer")
    func sessionReadsKeymap() async throws {
        let keypad = EmulatedKeypad(layer: 2, keymap: paseoLayer2Keymap)
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.inputLayers == [2, 4] })
        #expect(await eventually { await session.state.lightsVisible })
        #expect(await session.state.layerDescription == "2 (Paseo layer)")
        #expect(await session.state.litKeysOnLayer == [0, 1, 6])
        #expect(keypad.requests.filter { $0.method == "fs.read" }.count == 1)
        #expect(!keypad.requests.contains { KeypadMethod.fileWrites.contains($0.method) })
        await session.stop()
    }

    @Test("The session falls back to layer 4 when the keymap cannot be read")
    func sessionFallsBack() async throws {
        let keypad = EmulatedKeypad(layer: 4, keymap: "not a keymap")
        let session = await startSession(keypad)
        #expect(await eventually { await keypad.requests.contains { $0.method == "fs.read" } })
        #expect(await eventually { await session.state.lightsVisible })
        #expect(await session.state.inputLayers == [4])
        #expect(await session.state.litKeysOnLayer == Set(0 ... 5))
        await session.stop()
    }

    @Test("The session reads the keymap again for a layer it has not seen, at most once per interval")
    func sessionRereads() async throws {
        let keypad = EmulatedKeypad(layer: 4)
        let session = await startSession(keypad, keymapRefreshInterval: .zero)
        #expect(await eventually { await session.state.lightsVisible })
        #expect(await session.state.inputLayers == [4])
        keypad.setKeymap(paseoLayer2Keymap)
        keypad.setLayer(2)
        #expect(await eventually { await session.state.inputLayers == [2, 4] })
        #expect(await eventually { await session.state.lightsVisible })
        // Layer 2 is now seen, so polls on it do not read the keymap again.
        let reads = keypad.requests.filter { $0.method == "fs.read" }.count
        try await Task.sleep(for: .milliseconds(200))
        #expect(keypad.requests.filter { $0.method == "fs.read" }.count == reads)
        await session.stop()

        let limited = EmulatedKeypad(layer: 4)
        let slow = await startSession(limited, keymapRefreshInterval: .seconds(60))
        #expect(await eventually { await slow.state.lightsVisible })
        limited.setKeymap(paseoLayer2Keymap)
        limited.setLayer(2)
        #expect(await eventually { await slow.state.layer == 2 })
        try await Task.sleep(for: .milliseconds(200))
        #expect(await slow.state.inputLayers == [4])
        #expect(await !slow.state.lightsVisible)
        #expect(limited.requests.filter { $0.method == "fs.read" }.count == 1)
        await slow.stop()
    }

    @Test("The session sends the lights again when the keypad returns to any input layer")
    func sessionReappliesOnInputLayer() async throws {
        let keypad = EmulatedKeypad(layer: 2, keymap: paseoLayer2Keymap)
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.lightsVisible })
        try await session.setKeyLights([KeyLight(key: 1, color: .white)])
        keypad.setLayer(1)
        #expect(await eventually { await session.state.layer == 1 })
        keypad.clearRequests()
        keypad.setLayer(2)
        #expect(await eventually { keypad.requests.contains { $0.method == "v.oai.thstatus" } })
        await session.stop()
    }
}
