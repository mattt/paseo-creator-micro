import CoreGraphics
import CreatorMicro
import Foundation
@testable import PaseoMicroCore
import Testing

@Suite("Bridge")
struct BridgeTests {
    /// Runs a bridge on a temporary socket for the duration of a test.
    private func withBridge(
        keypad: EmulatedKeypad = EmulatedKeypad(),
        interface: RecordingInterface = RecordingInterface(),
        _ body: (String, KeypadSession, EmulatedKeypad) async throws -> Void
    ) async throws {
        let session = await startSession(keypad)
        #expect(
            await eventually {
                let state = await session.state; return state.firmware != nil && state.layer != nil
            }
        )
        let path = temporarySocketPath()
        let bridge = try await BridgeServer.bind(path: path, session: session, interface: interface)
        let running = Task { try await bridge.run() }
        defer {
            bridge.close()
            running.cancel()
            try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        }
        try await body(path, session, keypad)
        await session.stop()
    }

    /// Reads messages until one matches.
    private func next(
        _ iterator: inout BridgeClient.Messages.AsyncIterator,
        where match: (BridgeMessage) -> Bool
    ) async throws -> BridgeMessage? {
        while let message = try await iterator.next() {
            if match(message) { return message }
        }
        return nil
    }

    private func isResult(_ id: Int) -> (BridgeMessage) -> Bool {
        { if case .result(id, _, _) = $0 { true } else { false } }
    }

    @Test("Creates the socket with mode 0600")
    func socketMode() async throws {
        try await withBridge { path, _, _ in
            let attributes = try FileManager.default.attributesOfItem(atPath: path)
            #expect((attributes[.posixPermissions] as? Int) == 0o600)
            let folder = try FileManager.default.attributesOfItem(
                atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path
            )
            #expect((folder[.posixPermissions] as? Int) == 0o700)
        }
    }

    @Test("Refuses to replace a socket that another server listens on")
    func alreadyRunning() async throws {
        try await withBridge { path, session, _ in
            await #expect(throws: BridgeError.alreadyRunning(path)) {
                try await BridgeServer.bind(path: path, session: session)
            }
        }
    }

    @Test("Refuses a regular file, a folder, or a socket it cannot check, and leaves them")
    func refusesOtherFiles() async throws {
        let session = KeypadSession(transport: EmulatedKeypad())
        let path = temporarySocketPath()
        let folder = try makeSocketFolder(for: path)
        defer { try? FileManager.default.removeItem(atPath: folder) }

        try Data("keep me".utf8).write(to: URL(fileURLWithPath: path))
        await #expect(throws: BridgeError.notSocket(path)) { try await BridgeServer.bind(path: path, session: session) }
        #expect(try String(contentsOfFile: path, encoding: .utf8) == "keep me")
        try FileManager.default.removeItem(atPath: path)

        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: false)
        await #expect(throws: BridgeError.notSocket(path)) { try await BridgeServer.bind(path: path, session: session) }
        var isFolder: ObjCBool = false
        #expect(FileManager.default.fileExists(atPath: path, isDirectory: &isFolder) && isFolder.boolValue)
        try FileManager.default.removeItem(atPath: path)

        // A socket that the owner cannot open makes connect fail with EACCES, not ECONNREFUSED.
        try makeStaleSocket(at: path)
        chmod(path, 0)
        await #expect(throws: BridgeError.probeFailed(path, EACCES)) {
            try await BridgeServer.bind(path: path, session: session)
        }
        #expect(FileManager.default.fileExists(atPath: path))
    }

    @Test("Refuses a socket folder with a mode other than 0700")
    func refusesOpenFolder() async throws {
        let session = KeypadSession(transport: EmulatedKeypad())
        let path = temporarySocketPath()
        let folder = try makeSocketFolder(for: path, mode: 0o755)
        defer { try? FileManager.default.removeItem(atPath: folder) }
        await #expect(throws: BridgeError.unsafeFolder(folder, "its mode is 0755, not 0700")) {
            try await BridgeServer.bind(path: path, session: session)
        }
        #expect(!FileManager.default.fileExists(atPath: path))
    }

    @Test("Replaces a stale socket on which nothing listens")
    func replacesStaleSocket() async throws {
        let session = KeypadSession(transport: EmulatedKeypad())
        let path = temporarySocketPath()
        let folder = try makeSocketFolder(for: path)
        defer { try? FileManager.default.removeItem(atPath: folder) }
        try makeStaleSocket(at: path)
        let bridge = try await BridgeServer.bind(path: path, session: session, interface: RecordingInterface())
        let running = Task { try await bridge.run() }
        let client = try await BridgeClient.connect(path: path)
        let hello = try await client.run { messages, _ in
            var iterator = messages.makeAsyncIterator()
            return try await iterator.next()
        }
        #expect(hello.map { if case .hello = $0 { true } else { false } } == true)
        bridge.close()
        #expect(await finishes(running))
    }

    @Test("Closing ends run, closes idle clients, and removes the socket")
    func closeWithIdleClient() async throws {
        let session = KeypadSession(transport: EmulatedKeypad())
        let path = temporarySocketPath()
        defer {
            try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        }
        let bridge = try await BridgeServer.bind(path: path, session: session, interface: RecordingInterface())
        let running = Task { try await bridge.run() }
        let client = try await BridgeClient.connect(path: path)
        let reading = Task {
            try await client.run { messages, _ in
                for try await _ in messages {}
            }
        }
        #expect(await eventually { bridge.clients.count == 1 })
        bridge.close()
        #expect(!FileManager.default.fileExists(atPath: path))
        #expect(await finishes(running))
        #expect(await finishes(reading))
        reading.cancel()
    }

    @Test("Canceling run closes idle clients")
    func cancelWithIdleClient() async throws {
        let session = KeypadSession(transport: EmulatedKeypad())
        let path = temporarySocketPath()
        defer {
            try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        }
        let bridge = try await BridgeServer.bind(path: path, session: session, interface: RecordingInterface())
        let running = Task { try await bridge.run() }
        let client = try await BridgeClient.connect(path: path)
        let reading = Task {
            try await client.run { messages, _ in
                for try await _ in messages {}
            }
        }
        #expect(await eventually { bridge.clients.count == 1 })
        running.cancel()
        #expect(await finishes(running))
        #expect(await finishes(reading))
        #expect(!FileManager.default.fileExists(atPath: path))
        reading.cancel()
    }

    @Test("Closing a server leaves a newer socket at its path")
    func closeLeavesNewerSocket() async throws {
        let session = KeypadSession(transport: EmulatedKeypad())
        let path = temporarySocketPath()
        defer {
            try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        }
        let old = try await BridgeServer.bind(path: path, session: session, interface: RecordingInterface())
        let oldRunning = Task { try await old.run() }
        try FileManager.default.moveItem(atPath: path, toPath: path + ".old")
        let new = try await BridgeServer.bind(path: path, session: session, interface: RecordingInterface())
        let newRunning = Task { try await new.run() }
        old.close()
        #expect(await finishes(oldRunning))
        #expect(FileManager.default.fileExists(atPath: path))
        #expect(FileManager.default.fileExists(atPath: path + ".old"))
        new.close()
        #expect(await finishes(newRunning))
        #expect(!FileManager.default.fileExists(atPath: path))
    }

    @Test("A new server on the same path keeps its socket when the old one finishes")
    func restartOnSamePath() async throws {
        let session = KeypadSession(transport: EmulatedKeypad())
        let path = temporarySocketPath()
        defer {
            try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        }
        let old = try await BridgeServer.bind(path: path, session: session, interface: RecordingInterface())
        let oldRunning = Task { try await old.run() }
        let client = try await BridgeClient.connect(path: path)
        let reading = Task {
            try await client.run { messages, _ in
                for try await _ in messages {}
            }
        }
        #expect(await eventually { old.clients.count == 1 })
        old.close()

        let new = try await BridgeServer.bind(path: path, session: session, interface: RecordingInterface())
        let newRunning = Task { try await new.run() }
        reading.cancel()
        #expect(await finishes(oldRunning))
        #expect(FileManager.default.fileExists(atPath: path))
        let hello = try await BridgeClient.connect(path: path).run { messages, _ in
            var iterator = messages.makeAsyncIterator()
            return try await iterator.next()
        }
        #expect(hello.map { if case .hello = $0 { true } else { false } } == true)
        new.close()
        #expect(await finishes(newRunning))
    }

    @Test("Disconnects a client that does not read, and keeps serving the others")
    func disconnectsSlowClient() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.connected })
        let path = temporarySocketPath()
        defer {
            try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        }
        let bridge = try await BridgeServer.bind(
            path: path,
            session: session,
            interface: RecordingInterface(),
            clientQueueLimit: 8
        )
        let running = Task { try await bridge.run() }
        let stalled = try connectUnix(path: path)
        defer { close(stalled) }
        #expect(await eventually { bridge.clients.count == 1 })
        for _ in 0 ..< 3000 { keypad.tap(key: 0) }
        #expect(await eventually(timeout: .seconds(5)) { bridge.clients.isEmpty })
        // Let the burst finish before another client connects, so that it does not overflow that client too.
        keypad.tap(key: 2)
        #expect(await eventually { await session.lastInput == .key(KeyInput(key: 2, action: .release)) })

        let client = try await BridgeClient.connect(path: path)
        try await client.run { messages, _ in
            var iterator = messages.makeAsyncIterator()
            _ = try await iterator.next()
            keypad.tap(key: 1)
            #expect(
                try await next(&iterator) { if case .input(.key(let key)) = $0 { key.key == 1 } else { false } }
                    != nil
            )
        }
        bridge.close()
        #expect(await finishes(running))
        await session.stop()
    }

    @Test(
        "Disconnects a client that missed inputs before they reached its queue, and keeps serving",
        .timeLimit(.minutes(1))
    )
    func disconnectsClientThatMissedInputs() async throws {
        let keypad = EmulatedKeypad()
        let session = KeypadSession(
            transport: keypad,
            pollInterval: .seconds(60),
            requestTimeout: .seconds(1),
            eventBufferLimit: 8
        )
        await session.start()
        #expect(await eventually { await session.state.layer == 4 })
        let path = temporarySocketPath()
        defer {
            try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        }
        let bridge = try await BridgeServer.bind(path: path, session: session, interface: RecordingInterface())
        let running = Task { try await bridge.run() }
        let probe = await session.client.events()
        let expected = (0 ..< 10).flatMap { tapInputs(key: $0) }

        let client = try await BridgeClient.connect(path: path)
        let (received, ended) = try await client.run { messages, _ in
            var iterator = messages.makeAsyncIterator()
            _ = try await iterator.next()
            await session.holdEvents()
            for key in 0 ..< 10 { keypad.tap(key: key) }
            #expect(try await readInputs(from: probe, count: expected.count) == expected)
            await session.releaseEvents()
            var received: [KeypadInput] = []
            do {
                while let message = try await iterator.next() {
                    if case .input(let input) = message { received.append(input) }
                }
            } catch {
                // The connection closed with an error, which also counts as an end.
            }
            return (received, true)
        }
        // The client gets at most the inputs that reached the session before it fell behind, in order,
        // then the bridge disconnects it; the disconnection may cut off the last few.
        #expect(ended)
        #expect(received.count <= 9)
        #expect(received == Array(expected.prefix(received.count)))
        #expect(await eventually { bridge.clients.isEmpty })

        let again = try await BridgeClient.connect(path: path)
        try await again.run { messages, _ in
            var iterator = messages.makeAsyncIterator()
            _ = try await iterator.next()
            keypad.turnDial(clockwise: true)
            #expect(
                try await next(&iterator) { if case .input = $0 { true } else { false } } == .input(.dial(.clockwise))
            )
        }
        bridge.close()
        #expect(await finishes(running))
        await session.stop()
    }

    @Test("Greets clients, streams inputs, and answers commands")
    func endToEnd() async throws {
        try await withBridge { path, session, keypad in
            let client = try await BridgeClient.connect(path: path)
            try await client.run { messages, writer in
                var iterator = messages.makeAsyncIterator()
                let hello = try await iterator.next()
                let state = await session.state
                #expect(hello == .hello(protocolVersion: 1, appVersion: "0.1.0", keypad: state))

                keypad.tap(key: 3)
                #expect(
                    try await next(&iterator) { if case .input = $0 { true } else { false } }
                        == .input(.key(KeyInput(key: 3, action: .press)))
                )
                #expect(try await iterator.next() == .input(.key(KeyInput(key: 3, action: .release))))

                try await writer.send(
                    rawLine:
                        ##"{"type":"setKeyLights","id":7,"lights":[{"key":0,"color":"#FF2D2D","brightness":1,"effect":"breathing","speed":0.5}]}"##
                )
                #expect(try await next(&iterator, where: isResult(7)) == .result(id: 7, ok: true, error: nil))
                #expect(
                    keypad.keyLights[0] == KeyLight(key: 0, color: LightColor(packed: 0xFF2D2D), effect: .breathing)
                )

                try await writer.send(
                    rawLine:
                        ##"{"type":"setZones","id":8,"keys":{"color":"#FFFFFF","effect":"solid","brightness":0.3}}"##
                )
                #expect(try await next(&iterator, where: isResult(8)) == .result(id: 8, ok: true, error: nil))
                #expect(keypad.zones.keys == ZoneLight(color: .white, effect: .solid, brightness: 0.3))

                try await writer.send(BridgeCommand(id: 9, .clearLights))
                #expect(try await next(&iterator, where: isResult(9)) == .result(id: 9, ok: true, error: nil))
                #expect(keypad.keyLights.values.allSatisfy { $0.effect == .off })

                try await writer.send(BridgeCommand(id: 10, .getState))
                #expect(
                    try await next(&iterator) { if case .keypad = $0 { true } else { false } }
                        == .keypad(await session.state)
                )
                #expect(try await next(&iterator, where: isResult(10)) == .result(id: 10, ok: true, error: nil))

                keypad.setLayer(1)
                let change = try await next(&iterator) { if case .keypad(let s) = $0 { s.layer == 1 } else { false } }
                guard case .keypad(let changed) = change else {
                    Issue.record("Expected a keypad message")
                    return
                }
                #expect(!changed.lightsVisible)
            }
        }
    }

    @Test("Answers bad commands with errors when they carry an id")
    func errors() async throws {
        try await withBridge { path, _, _ in
            let client = try await BridgeClient.connect(path: path)
            try await client.run { messages, writer in
                var iterator = messages.makeAsyncIterator()
                _ = try await iterator.next()
                try await writer.send(rawLine: "not json")
                try await writer.send(rawLine: #"{"type":"dance","id":1}"#)
                try await writer.send(
                    rawLine: ##"{"type":"setKeyLights","id":2,"lights":[{"key":40,"color":"#FFFFFF"}]}"##
                )
                try await writer.send(rawLine: #"{"type":"setKeyLights","id":3,"lights":[{"key":0,"color":"blue"}]}"#)
                try await writer.send(rawLine: #"{"type":"clearLights"}"#)
                try await writer.send(rawLine: #"{"type":"getState","id":4}"#)
                var results: [Int: String?] = [:]
                while results[4] == nil, let message = try await iterator.next() {
                    if case .result(let id, let ok, let error) = message {
                        results[id] = ok ? nil : error
                        if ok { results[id] = .some(nil) }
                    }
                }
                #expect(results.keys.sorted() == [1, 2, 3, 4])
                #expect(results[1]??.contains("dance") == true)
                #expect(results[2]??.contains("Key 40") == true)
                #expect(results[3]??.contains("blue") == true)
            }
        }
    }

    @Test("Closes a connection that sends a line over 1 MiB, even with a newline")
    func closesOnLongLine() async throws {
        try await withBridge { path, _, _ in
            let client = try await BridgeClient.connect(path: path)
            let padding = String(repeating: "x", count: 1024 * 1024)
            let ended = try await client.run { messages, writer in
                var iterator = messages.makeAsyncIterator()
                _ = try await iterator.next()
                try await writer.send(rawLine: #"{"type":"getState","id":5,"padding":""# + padding + #""}"#)
                do {
                    while let message = try await iterator.next() {
                        if case .result(5, _, _) = message { return false }
                    }
                } catch {
                    // The connection closed with an error, which also counts.
                }
                return true
            }
            #expect(ended)
        }
    }

    @Test("Opens only paseo:// links")
    func openURL() async throws {
        let interface = RecordingInterface()
        try await withBridge(interface: interface) { path, _, _ in
            let client = try await BridgeClient.connect(path: path)
            try await client.run { messages, writer in
                var iterator = messages.makeAsyncIterator()
                try await writer.send(BridgeCommand(id: 11, .openURL("paseo://h/srv_1/agent/abc")))
                #expect(try await next(&iterator, where: isResult(11)) == .result(id: 11, ok: true, error: nil))
                try await writer.send(BridgeCommand(id: 12, .openURL("https://example.com")))
                let refused = try await next(&iterator, where: isResult(12))
                guard case .result(12, false, let error?) = refused else {
                    Issue.record("Expected an error result, got \(String(describing: refused))")
                    return
                }
                #expect(error.contains("paseo://"))
            }
        }
        #expect(interface.calls == [.open(URL(string: "paseo://h/srv_1/agent/abc")!)])
    }

    @Test("Sends shortcuts, activating the app first when asked")
    func sendShortcut() async throws {
        let interface = RecordingInterface()
        try await withBridge(interface: interface) { path, _, _ in
            let client = try await BridgeClient.connect(path: path)
            try await client.run { messages, writer in
                var iterator = messages.makeAsyncIterator()
                try await writer.send(
                    rawLine:
                        #"{"type":"sendShortcut","id":12,"bundleID":"sh.paseo.desktop","shortcut":"cmd+d","activate":true}"#
                )
                #expect(try await next(&iterator, where: isResult(12)) == .result(id: 12, ok: true, error: nil))
                try await writer.send(
                    BridgeCommand(id: 13, .sendShortcut(shortcut: "return", bundleID: nil, activate: false))
                )
                #expect(try await next(&iterator, where: isResult(13)) == .result(id: 13, ok: true, error: nil))
                try await writer.send(
                    BridgeCommand(id: 14, .sendShortcut(shortcut: "cmd+nope", bundleID: nil, activate: false))
                )
                #expect(
                    try await next(&iterator, where: isResult(14)).map {
                        if case .result(_, false, _) = $0 { true } else { false }
                    } == true
                )
                try await writer.send(
                    BridgeCommand(id: 15, .sendShortcut(shortcut: "cmd+d", bundleID: nil, activate: true))
                )
                #expect(
                    try await next(&iterator, where: isResult(15)).map {
                        if case .result(_, false, _) = $0 { true } else { false }
                    } == true
                )
            }
        }
        #expect(
            interface.calls == [
                .activate("sh.paseo.desktop"),
                .post("cmd+d", frontmost: "sh.paseo.desktop"),
                .post("return", frontmost: "sh.paseo.desktop"),
            ]
        )
    }

    /// Sends one command from a new client and returns its result.
    private func result(of command: BridgeCommand, path: String) async throws -> BridgeMessage? {
        let client = try await BridgeClient.connect(path: path)
        return try await client.run { messages, writer in
            var iterator = messages.makeAsyncIterator()
            try await writer.send(command)
            return try await next(&iterator, where: isResult(command.id ?? 0))
        }
    }

    @Test("Does not post a shortcut when the app does not come to the front")
    func shortcutActivationFails() async throws {
        let interface = RecordingInterface(frontmost: "com.apple.finder", activationDelay: nil)
        try await withBridge(interface: interface) { path, _, _ in
            let result = try await result(
                of: BridgeCommand(
                    id: 1,
                    .sendShortcut(shortcut: "return", bundleID: "sh.paseo.desktop", activate: true)
                ),
                path: path
            )
            #expect(
                result
                    == .result(id: 1, ok: false, error: InterfaceError.activationFailed("sh.paseo.desktop").description)
            )
        }
        #expect(interface.calls == [.activate("sh.paseo.desktop")])
    }

    @Test("Does not post a shortcut for an app that is not frontmost")
    func shortcutNotFrontmost() async throws {
        let interface = RecordingInterface(frontmost: "com.apple.finder")
        try await withBridge(interface: interface) { path, _, _ in
            let result = try await result(
                of: BridgeCommand(
                    id: 1,
                    .sendShortcut(shortcut: "return", bundleID: "sh.paseo.desktop", activate: false)
                ),
                path: path
            )
            #expect(
                result == .result(id: 1, ok: false, error: InterfaceError.notFrontmost("sh.paseo.desktop").description)
            )
        }
        #expect(interface.calls.isEmpty)
    }

    @Test("Sends shortcuts from several clients one at a time, each to its own app")
    func shortcutsAreSerialized() async throws {
        let interface = RecordingInterface(frontmost: "com.apple.finder")
        try await withBridge(interface: interface) { path, _, _ in
            async let first = result(
                of: BridgeCommand(id: 1, .sendShortcut(shortcut: "cmd+d", bundleID: "app.one", activate: true)),
                path: path
            )
            async let second = result(
                of: BridgeCommand(id: 2, .sendShortcut(shortcut: "cmd+e", bundleID: "app.two", activate: true)),
                path: path
            )
            let results = try await [first, second]
            #expect(results == [.result(id: 1, ok: true, error: nil), .result(id: 2, ok: true, error: nil)])
        }
        let one: [RecordingInterface.Call] = [.activate("app.one"), .post("cmd+d", frontmost: "app.one")]
        let two: [RecordingInterface.Call] = [.activate("app.two"), .post("cmd+e", frontmost: "app.two")]
        #expect(interface.calls == one + two || interface.calls == two + one)
    }

    @Test("Closing the bridge drops a shortcut that waits for another")
    func closeDropsQueuedShortcut() async throws {
        let interface = RecordingInterface(frontmost: "com.apple.finder", activationDelay: nil)
        let session = await startSession(EmulatedKeypad())
        let path = temporarySocketPath()
        defer {
            try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        }
        let bridge = try await BridgeServer.bind(path: path, session: session, interface: interface)
        let running = Task { try await bridge.run() }
        let first = try connectUnix(path: path)
        defer { close(first) }
        let second = try connectUnix(path: path)
        defer { close(second) }
        func send(_ line: String, to fd: Int32) {
            let bytes = Array((line + "\n").utf8)
            #expect(write(fd, bytes, bytes.count) == bytes.count)
        }

        send(#"{"type":"sendShortcut","id":1,"shortcut":"cmd+d","bundleID":"app.one","activate":true}"#, to: first)
        #expect(await eventually { interface.calls == [.activate("app.one")] })
        send(#"{"type":"sendShortcut","id":2,"shortcut":"cmd+e","bundleID":"app.two","activate":true}"#, to: second)
        try await Task.sleep(for: .milliseconds(200))
        bridge.close()
        #expect(await finishes(running))
        // Wait past the activation timeout, in case the queued shortcut still runs.
        try await Task.sleep(for: .milliseconds(1200))
        #expect(interface.calls == [.activate("app.one")])
        await session.stop()
    }

    @Test("Refuses shortcuts without the Accessibility permission")
    func shortcutNeedsAccessibility() async throws {
        let interface = RecordingInterface(trusted: false)
        try await withBridge(interface: interface) { path, _, _ in
            let client = try await BridgeClient.connect(path: path)
            try await client.run { messages, writer in
                var iterator = messages.makeAsyncIterator()
                try await writer.send(
                    BridgeCommand(id: 1, .sendShortcut(shortcut: "cmd+d", bundleID: "sh.paseo.desktop", activate: true))
                )
                let result = try await next(&iterator, where: isResult(1))
                #expect(result == .result(id: 1, ok: false, error: InterfaceError.accessibilityNotGranted.description))
            }
        }
        #expect(interface.calls.isEmpty)
    }

    private static let paseoWindow = AppWindow(
        processID: 4242,
        windowNumber: 77,
        bounds: CGRect(x: 100, y: 50, width: 800, height: 600)
    )

    @Test("Scrolls the app's frontmost window at a point in its conversation")
    func scroll() async throws {
        let interface = RecordingInterface(windows: ["sh.paseo.desktop": Self.paseoWindow])
        try await withBridge(interface: interface) { path, _, _ in
            let client = try await BridgeClient.connect(path: path)
            try await client.run { messages, writer in
                var iterator = messages.makeAsyncIterator()
                try await writer.send(
                    rawLine: #"{"type":"scroll","id":1,"bundleID":"sh.paseo.desktop","lines":3,"activate":true}"#
                )
                #expect(try await next(&iterator, where: isResult(1)) == .result(id: 1, ok: true, error: nil))
                try await writer.send(
                    BridgeCommand(
                        id: 2,
                        .scroll(lines: -2, bundleID: "sh.paseo.desktop", activate: false, fromTop: 0.5)
                    )
                )
                #expect(try await next(&iterator, where: isResult(2)) == .result(id: 2, ok: true, error: nil))
            }
        }
        #expect(
            interface.calls == [
                .activate("sh.paseo.desktop"),
                .scroll(wheel: -3, at: CGPoint(x: 500, y: 290), window: 77, frontmost: "sh.paseo.desktop"),
                .scroll(wheel: 2, at: CGPoint(x: 500, y: 350), window: 77, frontmost: "sh.paseo.desktop"),
            ]
        )
    }

    @Test("Scrolls to an edge in a burst of capped events, and refuses a scroll with both lines and an edge")
    func scrollToEdge() async throws {
        let interface = RecordingInterface(windows: ["sh.paseo.desktop": Self.paseoWindow])
        try await withBridge(interface: interface) { path, _, _ in
            let client = try await BridgeClient.connect(path: path)
            try await client.run { messages, writer in
                var iterator = messages.makeAsyncIterator()
                try await writer.send(
                    rawLine: #"{"type":"scroll","id":1,"bundleID":"sh.paseo.desktop","edge":"bottom","activate":true}"#
                )
                #expect(try await next(&iterator, where: isResult(1)) == .result(id: 1, ok: true, error: nil))
                try await writer.send(
                    BridgeCommand(
                        id: 2,
                        .scrollToEdge(.top, bundleID: "sh.paseo.desktop", activate: false, fromTop: 0.5)
                    )
                )
                #expect(try await next(&iterator, where: isResult(2)) == .result(id: 2, ok: true, error: nil))
                try await writer.send(
                    rawLine: #"{"type":"scroll","id":3,"bundleID":"sh.paseo.desktop","lines":3,"edge":"top"}"#
                )
                let refused = try await next(&iterator, where: isResult(3))
                #expect(
                    refused
                        == .result(
                            id: 3,
                            ok: false,
                            error: #"Invalid command: A scroll needs exactly one of "lines" and "edge""#
                        )
                )
            }
        }
        let down = RecordingInterface.Call.scroll(
            wheel: -100,
            at: CGPoint(x: 500, y: 290),
            window: 77,
            frontmost: "sh.paseo.desktop"
        )
        let up = RecordingInterface.Call.scroll(
            wheel: 100,
            at: CGPoint(x: 500, y: 350),
            window: 77,
            frontmost: "sh.paseo.desktop"
        )
        #expect(
            interface.calls
                == [.activate("sh.paseo.desktop")] + Array(repeating: down, count: 10) + Array(repeating: up, count: 10)
        )
        #expect(interface.pointer == RecordingInterface.home)
    }

    @Test("Refuses scrolls that are invalid, lack the permission, or have no window, without posting")
    func scrollRefusals() async throws {
        let paseo = "sh.paseo.desktop"
        let refusals: [(RecordingInterface, BridgeCommand, InterfaceError)] = [
            (
                RecordingInterface(windows: [paseo: Self.paseoWindow]),
                BridgeCommand(id: 1, .scroll(lines: 0, bundleID: paseo, activate: true, fromTop: nil)),
                .invalidScrollLines(0)
            ),
            (
                RecordingInterface(windows: [paseo: Self.paseoWindow]),
                BridgeCommand(id: 1, .scroll(lines: 3, bundleID: paseo, activate: true, fromTop: 1)),
                .invalidScrollPosition(1)
            ),
            (
                RecordingInterface(windows: [paseo: Self.paseoWindow]),
                BridgeCommand(id: 1, .scroll(lines: 3, bundleID: "", activate: false, fromTop: nil)),
                .missingBundleIdentifier
            ),
            (
                RecordingInterface(trusted: false, windows: [paseo: Self.paseoWindow]),
                BridgeCommand(id: 1, .scroll(lines: 3, bundleID: paseo, activate: true, fromTop: nil)),
                .accessibilityNotGranted
            ),
            (
                RecordingInterface(frontmost: paseo),
                BridgeCommand(id: 1, .scroll(lines: 3, bundleID: paseo, activate: false, fromTop: nil)),
                .noWindow(paseo)
            ),
            (
                RecordingInterface(windows: [paseo: Self.paseoWindow]),
                BridgeCommand(id: 1, .scrollToEdge(.bottom, bundleID: paseo, activate: true, fromTop: 0)),
                .invalidScrollPosition(0)
            ),
            (
                RecordingInterface(windows: [paseo: Self.paseoWindow]),
                BridgeCommand(id: 1, .scrollToEdge(.top, bundleID: "", activate: true, fromTop: nil)),
                .missingBundleIdentifier
            ),
            (
                RecordingInterface(trusted: false, windows: [paseo: Self.paseoWindow]),
                BridgeCommand(id: 1, .scrollToEdge(.bottom, bundleID: paseo, activate: true, fromTop: nil)),
                .accessibilityNotGranted
            ),
            (
                RecordingInterface(frontmost: paseo),
                BridgeCommand(id: 1, .scrollToEdge(.top, bundleID: paseo, activate: false, fromTop: nil)),
                .noWindow(paseo)
            ),
        ]
        for (interface, command, expected) in refusals {
            try await withBridge(interface: interface) { path, _, _ in
                let actual = try await result(of: command, path: path)
                #expect(actual == .result(id: 1, ok: false, error: expected.description))
            }
            #expect(!interface.calls.contains { if case .scroll = $0 { true } else { false } })
        }
    }

    @Test("Runs scrolls and shortcuts one at a time, each in its own app")
    func scrollsAndShortcutsAreSerialized() async throws {
        let interface = RecordingInterface(frontmost: "com.apple.finder", windows: ["app.one": Self.paseoWindow])
        try await withBridge(interface: interface) { path, _, _ in
            async let first = result(
                of: BridgeCommand(id: 1, .scroll(lines: 3, bundleID: "app.one", activate: true, fromTop: nil)),
                path: path
            )
            async let second = result(
                of: BridgeCommand(id: 2, .sendShortcut(shortcut: "cmd+e", bundleID: "app.two", activate: true)),
                path: path
            )
            let results = try await [first, second]
            #expect(results == [.result(id: 1, ok: true, error: nil), .result(id: 2, ok: true, error: nil)])
        }
        let one: [RecordingInterface.Call] = [
            .activate("app.one"), .scroll(wheel: -3, at: CGPoint(x: 500, y: 290), window: 77, frontmost: "app.one"),
        ]
        let two: [RecordingInterface.Call] = [.activate("app.two"), .post("cmd+e", frontmost: "app.two")]
        #expect(interface.calls == one + two || interface.calls == two + one)
    }

    @Test("Serves several clients and tracks them")
    func severalClients() async throws {
        let clients = ClientsBox()
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.connected })
        let path = temporarySocketPath()
        let bridge = try await BridgeServer.bind(path: path, session: session, interface: RecordingInterface()) {
            clients.set($0)
        }
        let running = Task { try await bridge.run() }
        let first = try await BridgeClient.connect(path: path)
        let second = try await BridgeClient.connect(path: path)
        try await first.run { firstMessages, _ in
            try await second.run { secondMessages, _ in
                var a = firstMessages.makeAsyncIterator()
                var b = secondMessages.makeAsyncIterator()
                _ = try await a.next()
                _ = try await b.next()
                #expect(bridge.clients.count == 2)
                #expect(bridge.clients.allSatisfy { $0.processID == getpid() })
                keypad.clickDial()
                #expect(try await next(&a) { if case .input = $0 { true } else { false } } == .input(.dial(.press)))
                #expect(try await next(&b) { if case .input = $0 { true } else { false } } == .input(.dial(.press)))
            }
        }
        #expect(await eventually { bridge.clients.isEmpty })
        #expect(clients.value.isEmpty)
        bridge.close()
        _ = await running.result
        #expect(!FileManager.default.fileExists(atPath: path))
        try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        await session.stop()
    }
}

private final class ClientsBox: Sendable {
    private let clients = Mutex<[BridgeClientInfo]>([])
    func set(_ value: [BridgeClientInfo]) { clients.withLock { $0 = value } }
    var value: [BridgeClientInfo] { clients.withLock { $0 } }
}

import Synchronization
