import CreatorMicro
@testable import PaseoMicroCore
import Testing

@Suite("Keypad session")
struct KeypadSessionTests {
    @Test("Connects, reads the firmware and status, and reports layer 4 lights as visible")
    func connects() async throws {
        let keypad = EmulatedKeypad(layer: 4, battery: 64, isCharging: true)
        let session = await startSession(keypad)
        #expect(
            await eventually {
                let state = await session.state; return state.battery == 64 && state.firmware != nil
            }
        )
        let state = await session.state
        #expect(
            state
                == KeypadState(
                    connected: true,
                    transport: "Emulated",
                    firmware: "0.6.3",
                    layer: 4,
                    battery: 64,
                    charging: true
                )
        )
        #expect(state.lightsVisible)
        await session.stop()
    }

    @Test("Polls the status and tracks layer and battery changes")
    func polls() async throws {
        let keypad = EmulatedKeypad(layer: 4)
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.layer == 4 })
        keypad.setLayer(1)
        keypad.setBattery(40, isCharging: false)
        #expect(await eventually { await session.state.layer == 1 })
        let state = await session.state
        #expect(state.battery == 40)
        #expect(state.charging == false)
        #expect(!state.lightsVisible)
        await session.stop()
    }

    @Test("Sends lights to the keypad and keeps them")
    func setsLights() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.connected })
        let light = KeyLight(key: 0, color: LightColor(packed: 0xFF2D2D), effect: .breathing)
        try await session.setKeyLights([light])
        try await session.setZones(keys: ZoneLight(color: .white, brightness: 0.3), ambient: nil)
        #expect(keypad.keyLights[0] == light)
        #expect(keypad.zones.keys == ZoneLight(color: .white, brightness: 0.3))
        #expect(await session.lights.light(forKey: 0) == light)
        await #expect(throws: SessionError.invalidKey(13)) {
            try await session.setKeyLights([KeyLight(key: 13, color: .white)])
        }
        await session.stop()
    }

    @Test("Applies the lights again after the keypad reconnects")
    func reappliesAfterReconnect() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.connected })
        let light = KeyLight(key: 5, color: LightColor(packed: 0x00FF00))
        try await session.setKeyLights([light])
        try await session.setZones(keys: nil, ambient: ZoneLight(color: LightColor(packed: 0x0000FF)))
        keypad.unplug()
        #expect(await eventually { await !session.state.connected })
        #expect(keypad.keyLights.isEmpty)
        keypad.plugIn()
        #expect(await eventually { keypad.keyLights[5] == light && keypad.zones.ambient != nil })
        #expect(await session.state.connected)
        await session.stop()
    }

    @Test("Lights set while disconnected go out on the next connection")
    func queuesLightsWhileDisconnected() async throws {
        let keypad = EmulatedKeypad(isPluggedIn: false)
        let session = await startSession(keypad)
        let light = KeyLight(key: 2, color: .white)
        try await session.setKeyLights([light])
        #expect(keypad.requests.isEmpty)
        keypad.plugIn()
        #expect(await eventually { keypad.keyLights[2] == light })
        await session.stop()
    }

    @Test("Applies the lights again when the keypad returns to layer 4 from a layer without vendor codes")
    func reappliesOnLayer4() async throws {
        let keypad = EmulatedKeypad(layer: 4)
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.layer == 4 })
        try await session.setKeyLights([KeyLight(key: 1, color: .white)])
        keypad.setLayer(2)
        #expect(await eventually { await session.state.layer == 2 })
        keypad.clearRequests()
        keypad.setLayer(4)
        #expect(await eventually { keypad.requests.contains { $0.method == "v.oai.thstatus" } })
        await session.stop()
    }

    @Test("Clears every light")
    func clears() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.connected })
        try await session.setKeyLights([KeyLight(key: 1, color: .white)])
        try await session.clearLights()
        #expect(await session.lights.isEmpty)
        #expect(keypad.keyLights.count == 13)
        #expect(keypad.keyLights.values.allSatisfy { $0.effect == .off })
        #expect(keypad.zones == ZoneLights(keys: .off, ambient: .off))
        await session.stop()
    }

    @Test("A zone that nobody set goes out as off, not white")
    func unsetZoneIsOff() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.connected })
        let blue = ZoneLight(color: LightColor(packed: 0x0000FF))
        try await session.setZones(keys: nil, ambient: blue)
        #expect(keypad.zones == ZoneLights(keys: .off, ambient: blue))
        #expect(await session.lights.zones == ZoneLights(ambient: blue))
        await session.stop()
    }

    @Test("After a clear, setting one zone leaves the other off")
    func partialZonesAfterClear() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.connected })
        let red = ZoneLight(color: LightColor(packed: 0xFF0000))
        let blue = ZoneLight(color: LightColor(packed: 0x0000FF))
        try await session.setZones(keys: .init(color: .white), ambient: red)
        try await session.clearLights()
        try await session.setZones(keys: nil, ambient: blue)
        #expect(keypad.zones == ZoneLights(keys: .off, ambient: blue))

        try await session.clearLights()
        try await session.setZones(keys: red, ambient: nil)
        #expect(keypad.zones == ZoneLights(keys: red, ambient: .off))

        try await session.clearLights()
        keypad.clearRequests()
        try await session.setZones(keys: nil, ambient: nil)
        #expect(!keypad.requests.contains { $0.method == KeypadMethod.zones })
        #expect(keypad.zones == ZoneLights(keys: .off, ambient: .off))
        #expect(await session.lights.isEmpty)
        await session.stop()
    }

    @Test("A replay that waits for a reply does not overwrite newer zones")
    func replayKeepsNewerZones() async throws {
        let keypad = EmulatedKeypad(layer: 4)
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.layer == 4 })
        let red = ZoneLight(color: LightColor(packed: 0xFF0000))
        let blue = ZoneLight(color: LightColor(packed: 0x0000FF))
        try await session.setKeyLights([KeyLight(key: 5, color: .white)])
        try await session.setZones(keys: nil, ambient: red)
        keypad.setLayer(2)
        #expect(await eventually { await session.state.layer == 2 })

        keypad.holdReplies(to: [KeypadMethod.keyLights])
        keypad.clearRequests()
        keypad.setLayer(4)
        #expect(await eventually { keypad.requests.contains { $0.method == KeypadMethod.keyLights } })
        let newer = Task { try await session.setZones(keys: nil, ambient: blue) }
        #expect(await eventually { await session.lights.zones.ambient == blue })
        try await Task.sleep(for: .milliseconds(100))
        keypad.releaseHeldReplies()
        try await newer.value
        #expect(await eventually { keypad.zones.ambient == blue })
        try await Task.sleep(for: .milliseconds(100))
        #expect(keypad.zones.ambient == blue)
        await session.stop()
    }

    @Test("A clear that waits for a reply keeps zones set during the wait")
    func clearKeepsNewerZones() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.connected })
        let red = ZoneLight(color: LightColor(packed: 0xFF0000))
        let blue = ZoneLight(color: LightColor(packed: 0x0000FF))
        try await session.setZones(keys: .init(color: .white), ambient: red)

        keypad.holdReplies(to: [KeypadMethod.keyLights])
        keypad.clearRequests()
        let clearing = Task { try await session.clearLights() }
        #expect(await eventually { keypad.requests.contains { $0.method == KeypadMethod.keyLights } })
        let newer = Task { try await session.setZones(keys: nil, ambient: blue) }
        #expect(await eventually { await session.lights.zones.ambient == blue })
        try await Task.sleep(for: .milliseconds(100))
        keypad.releaseHeldReplies()
        try await clearing.value
        try await newer.value
        let expected = ZoneLights(keys: .off, ambient: blue)
        #expect(await eventually { keypad.zones == expected })
        try await Task.sleep(for: .milliseconds(100))
        #expect(keypad.zones == expected)
        await session.stop()
    }

    @Test("While paused on the ChatGPT layer, lights wait and inputs still arrive; ChatGPT quitting applies them")
    func pausesLighting() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.layer == 4 })
        await session.setChatGPTRunning(true)
        #expect(await session.lightsPaused)
        keypad.clearRequests()

        let light = KeyLight(key: 0, color: LightColor(packed: 0xFF2D2D))
        let blue = ZoneLight(color: LightColor(packed: 0x0000FF))
        try await session.setKeyLights([light])
        try await session.setZones(keys: nil, ambient: blue)
        #expect(await session.lights.light(forKey: 0) == light)

        let waiter = Task { await session.nextInput(timeout: .seconds(2)) }
        try await Task.sleep(for: .milliseconds(50))
        keypad.turnDial(clockwise: true)
        #expect(await waiter.value == .dial(.clockwise))

        keypad.unplug()
        #expect(await eventually { await !session.state.connected })
        keypad.plugIn()
        #expect(await eventually { await session.state.layer == 4 })
        keypad.setLayer(1)
        #expect(await eventually { await session.state.layer == 1 })
        keypad.setLayer(4)
        #expect(await eventually { await session.state.layer == 4 })
        try await session.clearLights()
        try await session.setKeyLights([light])
        try await session.setZones(keys: nil, ambient: blue)
        let lighting: Set<String> = [KeypadMethod.keyLights, KeypadMethod.zones]
        #expect(!keypad.requests.contains { lighting.contains($0.method) })

        await session.setChatGPTRunning(false)
        #expect(await eventually { keypad.keyLights[0] == light && keypad.zones.ambient == blue })
        await session.stop()
    }

    @Test("A clear while paused turns the lights off when lighting resumes")
    func clearWhilePaused() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.layer == 4 })
        let red = KeyLight(key: 3, color: LightColor(packed: 0xFF0000))
        let blue = ZoneLight(color: LightColor(packed: 0x0000FF))
        try await session.setKeyLights([red])
        try await session.setZones(keys: nil, ambient: blue)
        #expect(keypad.keyLights[3] == red && keypad.zones.ambient == blue)

        await session.setChatGPTRunning(true)
        try await session.clearLights()
        #expect(keypad.keyLights[3] == red)
        await session.setChatGPTRunning(false)
        #expect(await eventually { keypad.keyLights[3]?.effect == .off })
        #expect(keypad.keyLights.count == 13)
        #expect(keypad.keyLights.values.allSatisfy { $0.effect == .off })
        #expect(keypad.zones == ZoneLights(keys: .off, ambient: .off))
        await session.stop()
    }

    @Test("A key set after a paused clear does not keep the other cleared keys lit")
    func partialUpdateAfterPausedClear() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.layer == 4 })
        let red = LightColor(packed: 0xFF0000)
        try await session.setKeyLights([KeyLight(key: 0, color: red), KeyLight(key: 2, color: red)])
        try await session.setZones(keys: nil, ambient: ZoneLight(color: red))

        await session.setChatGPTRunning(true)
        try await session.clearLights()
        let white = KeyLight(key: 1, color: .white)
        try await session.setKeyLights([white])
        await session.setChatGPTRunning(false)
        #expect(await eventually { keypad.keyLights[1] == white })
        #expect(keypad.keyLights[0]?.effect == .off)
        #expect(keypad.keyLights[2]?.effect == .off)
        #expect(keypad.zones == ZoneLights(keys: .off, ambient: .off))
        await session.stop()
    }

    @Test("A clear that the keypad did not confirm before it went away goes out after it returns")
    func clearInterruptedByDisconnect() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.layer == 4 })
        try await session.setKeyLights([KeyLight(key: 6, color: .white)])
        try await session.setZones(keys: nil, ambient: ZoneLight(color: LightColor(packed: 0x0000FF)))

        keypad.holdReplies(to: [KeypadMethod.zones])
        keypad.clearRequests()
        let clearing = Task { try await session.clearLights() }
        #expect(await eventually { keypad.requests.contains { $0.method == KeypadMethod.zones } })
        keypad.unplug()
        await #expect(throws: KeypadError.self) { try await clearing.value }
        keypad.releaseHeldReplies()
        #expect(await eventually { await !session.state.connected })

        keypad.plugIn()
        #expect(await eventually { keypad.zones == ZoneLights(keys: .off, ambient: .off) })
        #expect(await session.lights.isEmpty)
        await session.stop()
    }

    @Test("An updates stream that falls behind ends with an error instead of dropping changes")
    func updatesOverflow() async throws {
        let keypad = EmulatedKeypad()
        let session = KeypadSession(
            transport: keypad,
            pollInterval: .seconds(60),
            requestTimeout: .seconds(1),
            updateBufferLimit: 8
        )
        await session.start()
        #expect(await eventually { await session.state.layer == 4 })
        let stalled = await session.updates()
        for _ in 0 ..< 10 { keypad.turnDial(clockwise: true) }
        keypad.tap(key: 5)
        #expect(await eventually { await session.lastInput == .key(KeyInput(key: 5, action: .release)) })

        var received: [SessionEvent] = []
        await #expect(throws: SessionError.eventsLost) {
            for try await event in stalled { received.append(event) }
        }
        #expect(received == Array(repeating: .input(.dial(.clockwise)), count: 8))
        await session.stop()
    }

    @Test("When the session falls behind the keypad, its readers learn of it, and it recovers", .timeLimit(.minutes(1)))
    func eventsOverflow() async throws {
        let keypad = EmulatedKeypad()
        let session = KeypadSession(
            transport: keypad,
            pollInterval: .seconds(60),
            requestTimeout: .seconds(1),
            eventBufferLimit: 8
        )
        await session.start()
        #expect(await eventually { await session.state.layer == 4 })
        let reader = await session.updates()
        let probe = await session.client.events()
        let expected = (0 ..< 10).flatMap { tapInputs(key: $0) }

        await session.holdEvents()
        for key in 0 ..< 10 { keypad.tap(key: key) }
        #expect(try await readInputs(from: probe, count: expected.count) == expected)
        await session.releaseEvents()

        var received: [KeypadInput] = []
        await #expect(throws: SessionError.eventsLost) {
            for try await event in reader {
                if case .input(let input) = event { received.append(input) }
            }
        }
        // The input that the session held, then the eight that the client's stream kept.
        #expect(received == Array(expected.prefix(9)))

        #expect(
            await eventually {
                let next = Task { await session.nextInput(timeout: .milliseconds(200)) }
                try? await Task.sleep(for: .milliseconds(20))
                keypad.turnDial(clockwise: false)
                return await next.value == .dial(.counterclockwise)
            }
        )
        #expect(await session.state.connected)
        await session.stop()
    }

    @Test("Reports inputs, remembers the last, and waits for the next")
    func inputs() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.connected })
        let waiter = Task { await session.nextInput(timeout: .seconds(2)) }
        try await Task.sleep(for: .milliseconds(50))
        keypad.turnDial(clockwise: true)
        #expect(await waiter.value == .dial(.clockwise))
        #expect(await session.lastInput == .dial(.clockwise))
        #expect(await session.nextInput(timeout: .milliseconds(50)) == nil)
        await session.stop()
    }

    @Test("Never sends file writes")
    func noFileWrites() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.firmware != nil })
        try await session.setKeyLights([KeyLight(key: 0, color: .white)])
        try await session.clearLights()
        #expect(!keypad.requests.contains { KeypadMethod.fileWrites.contains($0.method) })
        await session.stop()
    }
}
