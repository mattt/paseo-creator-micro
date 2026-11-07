import CreatorMicro
import Foundation
@testable import PaseoMicroCore
import Testing

/// ``paseoLayer2Keymap`` with the names of layers 2 and 4 swapped, so that layer 2 is "ChatGPT".
let chatGPTLayer2Keymap =
    paseoLayer2Keymap
    .replacingOccurrences(of: #""name":"ChatGPT""#, with: #""name":"Layer 4""#)
    .replacingOccurrences(of: #""name":"Layer 2""#, with: #""name":"chatgpt""#)

@Suite("ChatGPT lighting")
struct ChatGPTLightingTests {
    private static let lightingMethods: Set<String> = [KeypadMethod.keyLights, KeypadMethod.zones]

    /// The lighting writes that the keypad received since its requests were last cleared.
    private func lightingWrites(_ keypad: EmulatedKeypad) -> [String] {
        keypad.requests.map(\.method).filter(Self.lightingMethods.contains)
    }

    /// Starts a session on a keypad whose input layers are 2 (the Paseo layer) and 4 ("ChatGPT"),
    /// and waits until the lighting writes that follow the connection finish.
    private func start(
        layer: Int,
        keymap: String = paseoLayer2Keymap,
        repaintInterval: Duration = KeypadSession.chatGPTRepaintInterval
    ) async -> (EmulatedKeypad, KeypadSession) {
        let keypad = EmulatedKeypad(layer: layer, keymap: keymap)
        let session = await startSession(keypad, repaintInterval: repaintInterval)
        #expect(await waitForConnection(session))
        let state = await session.state
        #expect(state.layer == layer)
        #expect(state.inputLayers == [2, 4])
        return (keypad, session)
    }

    @Test("Sends no lighting writes on the ChatGPT layer while ChatGPT runs, and keeps the desired lights")
    func noWritesOnChatGPTLayer() async throws {
        let (keypad, session) = await start(layer: 4)
        await session.setChatGPTRunning(true)
        let state = await session.state
        #expect(state.lightsPaused)
        #expect(state.chatGPTLayer == 4)
        #expect(state.lightingStatus == "paused on the ChatGPT layer (layer 4) while ChatGPT runs")
        keypad.clearRequests()

        let light = KeyLight(key: 0, color: .white)
        try await session.setKeyLights([light])
        try await session.setZones(keys: nil, ambient: ZoneLight(color: .white))
        try await session.clearLights()
        try await session.setKeyLights([light])
        await session.repaintForChatGPT()
        try await Task.sleep(for: .milliseconds(200))
        #expect(lightingWrites(keypad).isEmpty)
        #expect(await session.lights.light(forKey: 0) == light)
        await session.stop()
    }

    @Test("Leaving the ChatGPT layer paints every light at once, and entering it pauses writes again")
    func layerChanges() async throws {
        let (keypad, session) = await start(layer: 4)
        await session.setChatGPTRunning(true)
        let green = KeyLight(key: 1, color: LightColor(packed: 0x00FF00))
        try await session.setKeyLights([green])
        #expect(keypad.keyLights.isEmpty)

        keypad.setLayer(2)
        #expect(
            await eventually {
                keypad.keyLights[1] == green
                    && keypad.requests.contains { $0.method == KeypadMethod.zones }
            }
        )
        // Every key and both zones, to replace what Codex set.
        #expect(keypad.keyLights.count == KeyInput.count)
        #expect(keypad.keyLights[0]?.effect == .off)
        #expect(keypad.requests.contains { $0.method == KeypadMethod.zones })
        let state = await session.state
        #expect(!state.lightsPaused)
        #expect(state.lightingStatus == "not paused; repainted every 30 seconds while ChatGPT runs")

        keypad.setLayer(4)
        #expect(await eventually { await session.lightsPaused })
        keypad.clearRequests()
        let white = KeyLight(key: 2, color: .white)
        try await session.setKeyLights([white])
        try await Task.sleep(for: .milliseconds(150))
        #expect(lightingWrites(keypad).isEmpty)

        keypad.setLayer(2)
        #expect(await eventually { keypad.keyLights[2] == white })
        await session.stop()
    }

    @Test("ChatGPT launching or quitting on the Paseo layer paints every light at once")
    func launchAndQuitOnPaseoLayer() async throws {
        let (keypad, session) = await start(layer: 2)
        let light = KeyLight(key: 0, color: .white)
        try await session.setKeyLights([light])
        #expect(keypad.keyLights.count == 1)

        keypad.clearRequests()
        await session.setChatGPTRunning(true)
        #expect(await !session.lightsPaused)
        #expect(Set(lightingWrites(keypad)) == Self.lightingMethods)
        #expect(keypad.keyLights.count == KeyInput.count)
        #expect(keypad.keyLights[0] == light)

        keypad.clearRequests()
        await session.setChatGPTRunning(false)
        #expect(Set(lightingWrites(keypad)) == Self.lightingMethods)
        #expect(await session.state.lightingStatus == "not paused")
        await session.stop()
    }

    @Test("ChatGPT launching on the ChatGPT layer pauses writes, and quitting restores the lights")
    func launchAndQuitOnChatGPTLayer() async throws {
        let (keypad, session) = await start(layer: 4)
        let light = KeyLight(key: 0, color: .white)
        try await session.setKeyLights([light])

        keypad.clearRequests()
        await session.setChatGPTRunning(true)
        #expect(await session.lightsPaused)
        let blue = ZoneLight(color: LightColor(packed: 0x0000FF))
        try await session.setZones(keys: nil, ambient: blue)
        #expect(lightingWrites(keypad).isEmpty)

        await session.setChatGPTRunning(false)
        #expect(await !session.lightsPaused)
        #expect(keypad.keyLights[0] == light)
        #expect(keypad.keyLights.count == KeyInput.count)
        #expect(keypad.zones == ZoneLights(keys: .off, ambient: blue))
        await session.stop()
    }

    @Test("Repaints only while ChatGPT runs and the keypad is on an input layer other than the ChatGPT layer")
    func repaintConditions() async throws {
        let (keypad, session) = await start(layer: 2)
        try await session.setKeyLights([KeyLight(key: 0, color: .white)])

        keypad.clearRequests()
        await session.repaintForChatGPT()
        #expect(lightingWrites(keypad).isEmpty)

        await session.setChatGPTRunning(true)
        keypad.clearRequests()
        await session.repaintForChatGPT()
        #expect(Set(lightingWrites(keypad)) == Self.lightingMethods)

        keypad.setLayer(1)
        #expect(await eventually { await session.state.layer == 1 })
        keypad.clearRequests()
        await session.repaintForChatGPT()
        #expect(lightingWrites(keypad).isEmpty)

        keypad.setLayer(4)
        #expect(await eventually { await session.lightsPaused })
        keypad.clearRequests()
        await session.repaintForChatGPT()
        #expect(lightingWrites(keypad).isEmpty)
        await session.stop()
    }

    @Test("The repaint timer paints the lights each interval while ChatGPT runs, and stops when it quits")
    func repaintTimer() async throws {
        let (keypad, session) = await start(layer: 2, repaintInterval: .milliseconds(100))
        try await session.setKeyLights([KeyLight(key: 0, color: .white)])
        try await Task.sleep(for: .milliseconds(250))
        #expect(!keypad.requests.contains { $0.method == KeypadMethod.zones })

        await session.setChatGPTRunning(true)
        keypad.clearRequests()
        #expect(await eventually { keypad.requests.filter { $0.method == KeypadMethod.zones }.count >= 2 })

        // A repaint that waits behind the one for the quit paints nothing.
        await session.setChatGPTRunning(false)
        keypad.clearRequests()
        try await Task.sleep(for: .milliseconds(350))
        #expect(lightingWrites(keypad).isEmpty)
        await session.stop()
    }

    @Test("Finds the ChatGPT layer by name, else assumes layer 4")
    func chatGPTLayerFromKeymap() throws {
        let parse = { (text: String) in InputLayers.chatGPTLayer(keymap: try JSONValue(parsing: Data(text.utf8))) }
        #expect(try parse(EmulatedKeypad.stockKeymap) == 4)
        #expect(try parse(paseoLayer2Keymap) == 4)
        #expect(try parse(chatGPTLayer2Keymap) == 2)
        #expect(try parse(#"{"profiles":[{"layers":[{"name":"Layer 1"}]}]}"#) == nil)
        #expect(try parse("[]") == nil)
    }

    @Test("The session pauses on the layer that the keymap names ChatGPT, and on layer 4 without a keymap")
    func sessionChatGPTLayer() async throws {
        let (keypad, session) = await start(layer: 4, keymap: chatGPTLayer2Keymap)
        #expect(await session.state.chatGPTLayer == 2)
        await session.setChatGPTRunning(true)
        #expect(await !session.lightsPaused)
        keypad.setLayer(2)
        #expect(await eventually { await session.lightsPaused })
        #expect(await session.state.lightingStatus == "paused on the ChatGPT layer (layer 2) while ChatGPT runs")
        await session.stop()

        let unreadable = EmulatedKeypad(layer: 4, keymap: "not a keymap")
        let fallback = await startSession(unreadable)
        #expect(await eventually { await fallback.state.layer == 4 })
        #expect(await fallback.state.chatGPTLayer == 4)
        await fallback.setChatGPTRunning(true)
        #expect(await fallback.lightsPaused)
        await fallback.stop()
    }

    @Test("A state says why lighting is paused, and encodes it")
    func stateCoding() throws {
        let paused = KeypadState(connected: true, layer: 4, inputLayers: [2, 4], chatGPTRunning: true)
        #expect(paused.lightsPaused)
        let unknown = KeypadState(connected: true, chatGPTRunning: true)
        #expect(unknown.lightsPaused)
        #expect(unknown.lightingStatus == "paused while ChatGPT runs, until the keypad reports its layer")
        #expect(!KeypadState(connected: true, layer: 4).lightsPaused)

        let data = try JSONEncoder().encode(paused)
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.contains(#""chatGPTLayer":4"#))
        #expect(text.contains(#""chatGPTRunning":true"#))
        #expect(text.contains(#""lightsPaused":true"#))
        #expect(text.contains(#""lightingStatus":"paused on the ChatGPT layer (layer 4) while ChatGPT runs""#))
        #expect(try JSONDecoder().decode(KeypadState.self, from: data) == paused)

        let old = #"{"connected":true,"layer":4,"lightsVisible":true}"#
        let decoded = try JSONDecoder().decode(KeypadState.self, from: Data(old.utf8))
        #expect(decoded.chatGPTLayer == 4)
        #expect(!decoded.chatGPTRunning)
        #expect(decoded.lightingStatus == "not paused")
    }
}
