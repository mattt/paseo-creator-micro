import CreatorMicro
import Foundation
import Testing

@Suite("Keypad client and emulated keypad")
struct KeypadClientTests {
    /// Starts a client on an emulated keypad and waits for the connection.
    private func connect(_ keypad: EmulatedKeypad, firstRequestID: Int = 500) async throws -> (
        KeypadClient, AsyncThrowingStream<KeypadEvent, any Error>
    ) {
        let client = KeypadClient(transport: keypad, firstRequestID: firstRequestID)
        let events = await client.events()
        await client.start()
        var iterator = events.makeAsyncIterator()
        _ = try await iterator.next()
        return (client, events)
    }

    @Test("Answers like firmware 0.6.3")
    func firmwareAnswers() async throws {
        let keypad = EmulatedKeypad(layer: 4, battery: 64, isCharging: true)
        let (client, _) = try await connect(keypad)
        #expect(await client.device == EmulatedKeypad.defaultDevice)
        #expect(try await client.version() == "0.6.3")
        let status = try await client.status()
        #expect(status == KeypadStatus(battery: 64, isCharging: true, layer: 4, profile: 0, version: "0.6.3"))
        #expect(try await client.call("host.focused_app", params: ["app": "Paseo"]) == ["ok": 1])
        let files = try await client.call("fs.list")
        #expect(files.arrayValue?.compactMap { $0["name"]?.stringValue } == ["keymap.json", "smart_actions.json"])
        let keymap = try await client.call("fs.read", params: ["file": "keymap.json"])
        #expect(keymap["data"]?.stringValue?.contains("ACT12") == true)
        await client.stop()
    }

    @Test("Uses request identifiers that wrap from 999 to 1")
    func requestIDs() async throws {
        let keypad = EmulatedKeypad()
        let (client, _) = try await connect(keypad, firstRequestID: 998)
        for _ in 0 ..< 3 { _ = try await client.version() }
        #expect(keypad.requests.map(\.id) == [998, 999, 1])
        await client.stop()
    }

    @Test("Concurrent calls each get their own reply")
    func concurrentCalls() async throws {
        let keypad = EmulatedKeypad()
        let (client, _) = try await connect(keypad)
        async let version = client.version()
        async let status = client.status()
        async let lights: Void = client.setKeyLights((0 ..< 13).map { KeyLight(key: $0, color: .white) })
        let (v, s, _) = try await (version, status, lights)
        #expect(v == "0.6.3")
        #expect(s.layer == 4)
        #expect(keypad.keyLights.count == 13)
        #expect(Set(keypad.requests.map(\.id)).count == 3)
        await client.stop()
    }

    @Test("Times out when the keypad does not reply")
    func timeout() async throws {
        let keypad = EmulatedKeypad()
        let (client, _) = try await connect(keypad)
        keypad.isResponding = false
        let start = ContinuousClock.now
        await #expect(throws: KeypadError.timeout(method: "sys.version")) {
            try await client.call("sys.version", timeout: .milliseconds(100))
        }
        #expect(ContinuousClock.now - start < .seconds(2))
        keypad.isResponding = true
        #expect(try await client.version() == "0.6.3")
        await client.stop()
    }

    @Test("Refuses methods that write the keypad's files")
    func refusesFileWrites() async throws {
        let keypad = EmulatedKeypad()
        let (client, _) = try await connect(keypad)
        for method in ["fs.write", "fs.writebin", "fs.delete"] {
            await #expect(throws: KeypadError.forbiddenMethod(method)) {
                try await client.call(method, params: ["file": "keymap.json", "data": "{}"])
            }
        }
        #expect(keypad.requests.isEmpty)
        await client.stop()
    }

    @Test("Fails calls when no keypad is connected")
    func notConnected() async throws {
        let keypad = EmulatedKeypad(isPluggedIn: false)
        let client = KeypadClient(transport: keypad)
        await client.start()
        await #expect(throws: KeypadError.notConnected) { try await client.version() }
        await client.stop()
    }

    @Test("Fails waiting calls when the keypad is unplugged, and reconnects on replug")
    func unplugAndReplug() async throws {
        let keypad = EmulatedKeypad()
        let (client, events) = try await connect(keypad)
        keypad.isResponding = false
        let pending = Task { try await client.call("sys.version", timeout: .seconds(5)) }
        try await Task.sleep(for: .milliseconds(50))
        keypad.unplug()
        await #expect(throws: KeypadError.disconnected(method: "sys.version")) { try await pending.value }
        keypad.isResponding = true
        keypad.plugIn()
        var iterator = events.makeAsyncIterator()
        #expect(try await iterator.next() == .disconnected)
        #expect(try await iterator.next() == .connected(EmulatedKeypad.defaultDevice))
        #expect(try await client.version() == "0.6.3")
        await client.stop()
    }

    @Test("Delivers injected inputs as events")
    func inputs() async throws {
        let keypad = EmulatedKeypad()
        let (client, events) = try await connect(keypad)
        keypad.tap(key: 7)
        keypad.turnDial(clockwise: false)
        keypad.clickDial()
        keypad.moveJoystick(angle: 0.5, distance: 1, sector: 4)
        keypad.emit(message: .notification(method: "host.ping", params: nil))
        keypad.emit(message: .reply(id: 12, result: ["ok": 1], error: nil))
        var received: [KeypadEvent] = []
        for try await event in events {
            received.append(event)
            if received.count == 8 { break }
        }
        #expect(
            received == [
                .input(.key(KeyInput(key: 7, action: .press))),
                .input(.key(KeyInput(key: 7, action: .release))),
                .input(.dial(.counterclockwise)),
                .input(.dial(.press)),
                .input(.dial(.release)),
                .input(.joystick(JoystickInput(angle: 0.5, distance: 1, sector: 4))),
                .notification(method: "host.ping", params: nil),
                .foreignReply(id: 12),
            ]
        )
        await client.stop()
    }

    @Test("An event stream that falls behind ends with an error instead of dropping events")
    func eventOverflow() async throws {
        let keypad = EmulatedKeypad()
        let client = KeypadClient(transport: keypad)
        let reader = await client.events()
        let stalled = await client.events(bufferLimit: 8)
        await client.start()
        for _ in 0 ..< 20 { keypad.tap(key: 0) }
        var inputs = 0
        for try await event in reader {
            if case .input = event { inputs += 1 }
            if inputs == 40 { break }
        }

        var received: [KeypadEvent] = []
        await #expect(throws: KeypadError.eventsOverflowed) {
            for try await event in stalled { received.append(event) }
        }
        #expect(received.first == .connected(EmulatedKeypad.defaultDevice))
        #expect(received.count == 8)
        await client.stop()
    }

    @Test("Records the lights it is given")
    func lights() async throws {
        let keypad = EmulatedKeypad()
        let (client, _) = try await connect(keypad)
        let light = KeyLight(
            key: 4,
            color: LightColor(packed: 0x2D7DFF),
            brightness: 0.8,
            effect: .breathing,
            speed: 0.25
        )
        try await client.setKeyLights([light])
        let zones = ZoneLights(
            keys: ZoneLight(color: .white, brightness: 0.3),
            ambient: ZoneLight(color: LightColor(packed: 0xFF0000))
        )
        try await client.setZones(zones)
        #expect(keypad.keyLights[4] == light)
        #expect(keypad.zones == zones)
        #expect(keypad.requests.map(\.method) == ["v.oai.thstatus", "v.oai.rgbcfg"])
        await client.stop()
    }

    @Test("Keypad errors surface as remote errors")
    func remoteError() async throws {
        // A transport that answers every request with an error.
        final class FailingKeypad: KeypadTransport {
            let inner = EmulatedKeypad()
            func start(_ handler: @escaping @Sendable (KeypadTransportEvent) -> Void) { inner.start(handler) }
            func stop() { inner.stop() }
            func send(_ reports: [[UInt8]]) async throws {
                inner.isResponding = false
                try await inner.send(reports)
                let id = inner.requests.last?.id ?? 0
                inner.emit(
                    message: .reply(id: id, result: nil, error: ["code": -32601, "message": "Method not found"])
                )
            }
        }
        let client = KeypadClient(transport: FailingKeypad())
        let events = await client.events()
        await client.start()
        for try await event in events { if case .connected = event { break } }
        await #expect(
            throws: KeypadError.remote(method: "nope", error: ["code": -32601, "message": "Method not found"])
        ) {
            try await client.call("nope")
        }
        await client.stop()
    }
}
