import CreatorMicro
import Foundation
import MCP
@testable import PaseoMicroCore
import Testing

@Suite("MCP server")
struct MCPTests {
    private func withServer(
        _ body: (MCPHTTPServer, KeypadSession, EmulatedKeypad) async throws -> Void
    ) async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(
            await eventually {
                let state = await session.state; return state.firmware != nil && state.layer != nil
            }
        )
        let server = try await MCPHTTPServer.bind(
            port: 0,
            tools: KeypadTools(session: session)
        )
        let running = Task { try await server.run() }
        defer {
            server.close()
            running.cancel()
        }
        #expect(server.port != 0 && server.port != MCPHTTPServer.defaultPort)
        try await body(server, session, keypad)
        await session.stop()
    }

    private func connect(_ server: MCPHTTPServer) async throws -> Client {
        let client = Client(name: "tests", version: "1.0")
        try await client.connect(transport: HTTPClientTransport(endpoint: server.url, streaming: false))
        return client
    }

    private func text(_ content: [Tool.Content]) -> String {
        content.compactMap { if case .text(let text, _, _) = $0 { text } else { nil } }.joined()
    }

    private func json(_ content: [Tool.Content]) throws -> JSONValue {
        try JSONValue(parsing: Data(text(content).utf8))
    }

    @Test("Lists the tools")
    func listsTools() async throws {
        try await withServer { server, _, _ in
            let client = try await connect(server)
            let tools = try await client.listTools().tools.map(\.name)
            #expect(
                tools == ["get_keypad_state", "set_key_lights", "set_zone_lights", "clear_lights", "wait_for_input"]
            )
            await client.disconnect()
        }
    }

    @Test("Several clients can initialize against the stateless server")
    func severalClients() async throws {
        try await withServer { server, _, _ in
            let first = try await connect(server)
            let second = try await connect(server)
            _ = try await first.callTool(name: "get_keypad_state")
            _ = try await second.callTool(name: "get_keypad_state")
            await first.disconnect()
            await second.disconnect()
        }
    }

    @Test("Reports the keypad's state")
    func state() async throws {
        try await withServer { server, _, _ in
            let client = try await connect(server)
            let (content, isError) = try await client.callTool(name: "get_keypad_state")
            #expect(isError != true)
            let state = try json(content)
            #expect(state["keypad"]?["connected"] == true)
            #expect(state["keypad"]?["firmware"] == "0.6.3")
            #expect(state["keypad"]?["layer"] == 4)
            #expect(state["keypad"]?["chatGPTRunning"] == false)
            #expect(state["keypad"]?["chatGPTLayer"] == 4)
            #expect(state["keypad"]?["lightsPaused"] == false)
            #expect(state["keypad"]?["lightingStatus"] == "not paused")
            await client.disconnect()
        }
    }

    @Test("Sets key and zone lights, and clears them")
    func lights() async throws {
        try await withServer { server, session, keypad in
            let client = try await connect(server)
            let (_, keyError) = try await client.callTool(
                name: "set_key_lights",
                arguments: ["lights": [["key": 3, "color": "#2D7DFF", "effect": "breathing", "brightness": 0.8]]]
            )
            #expect(keyError != true)
            #expect(
                keypad.keyLights[3]
                    == KeyLight(key: 3, color: LightColor(packed: 0x2D7DFF), brightness: 0.8, effect: .breathing)
            )
            let (_, actionKeyError) = try await client.callTool(
                name: "set_key_lights",
                arguments: ["lights": [["key": 6, "color": "#FFD000"], ["key": 12, "color": "#2DFF6A"]]]
            )
            #expect(actionKeyError != true)
            #expect(keypad.keyLights[6] == KeyLight(key: 6, color: LightColor(packed: 0xFFD000)))
            #expect(keypad.keyLights[12] == KeyLight(key: 12, color: LightColor(packed: 0x2DFF6A)))
            let (_, zoneError) = try await client.callTool(
                name: "set_zone_lights",
                arguments: ["ambient": ["color": "#FF0000", "effect": "rainbow"]]
            )
            #expect(zoneError != true)
            #expect(keypad.zones.ambient == ZoneLight(color: LightColor(packed: 0xFF0000), effect: .rainbow))
            #expect(await session.lights.zones.keys == nil)
            let (_, clearError) = try await client.callTool(name: "clear_lights")
            #expect(clearError != true)
            #expect(await session.lights.isEmpty)
            await client.disconnect()
        }
    }

    @Test("Reports bad arguments as tool errors")
    func badArguments() async throws {
        try await withServer { server, _, keypad in
            let client = try await connect(server)
            let (content, isError) = try await client.callTool(
                name: "set_key_lights",
                arguments: ["lights": [["key": 99, "color": "#FFFFFF"]]]
            )
            #expect(isError == true)
            #expect(text(content).contains("Key 99"))
            let (_, colorError) = try await client.callTool(
                name: "set_key_lights",
                arguments: ["lights": [["key": 1, "color": "teal"]]]
            )
            #expect(colorError == true)
            #expect(!keypad.requests.contains { $0.method == "v.oai.thstatus" })
            await client.disconnect()
        }
    }

    @Test("Waits for the next input, or times out")
    func waitForInput() async throws {
        try await withServer { server, _, keypad in
            let client = try await connect(server)
            let pressing = Task {
                try await Task.sleep(for: .milliseconds(300))
                keypad.moveJoystick(angle: 0.25, distance: 1, sector: 2)
            }
            let (content, _) = try await client.callTool(name: "wait_for_input", arguments: ["timeout": 5])
            #expect(try json(content) == ["input": ["kind": "joystick", "angle": 0.25, "distance": 1, "sector": 2]])
            _ = try await pressing.value
            let (empty, _) = try await client.callTool(name: "wait_for_input", arguments: ["timeout": 0.1])
            #expect(try json(empty) == ["input": nil])
            await client.disconnect()
        }
    }

    @Test("Closing ends run with an idle connection and a waiting tool call")
    func closeWithOpenConnections() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        let server = try await MCPHTTPServer.bind(port: 0, tools: KeypadTools(session: session))
        let running = Task { try await server.run() }
        let idle = try connectLoopback(port: server.port)
        defer { close(idle) }
        let client = try await connect(server)
        let waiting = Task { try await client.callTool(name: "wait_for_input", arguments: ["timeout": 60]) }
        try await Task.sleep(for: .milliseconds(200))
        server.close()
        #expect(await finishes(running))
        waiting.cancel()
        await client.disconnect()
        await session.stop()
    }

    @Test("Closing ends a waiting wait_for_input call before run returns")
    func closeEndsWaitingToolCall() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.connected })
        let server = try await MCPHTTPServer.bind(port: 0, tools: KeypadTools(session: session))
        let running = Task { try await server.run() }
        let client = try await connect(server)
        let waiting = Task { try await client.callTool(name: "wait_for_input", arguments: ["timeout": 60]) }
        #expect(await eventually { await session.subscriberCount == 1 })
        server.close()
        #expect(await finishes(running))
        #expect(await session.subscriberCount == 0)
        waiting.cancel()
        await client.disconnect()
        await session.stop()
    }

    @Test("Closing cancels lighting calls that wait for the keypad, before run returns")
    func closeCancelsLightingCalls() async throws {
        let keypad = EmulatedKeypad()
        let session = KeypadSession(transport: keypad, pollInterval: .seconds(60), requestTimeout: .seconds(30))
        await session.start()
        #expect(await eventually { await session.state.layer == 4 })
        let server = try await MCPHTTPServer.bind(port: 0, tools: KeypadTools(session: session))
        let running = Task { try await server.run() }
        let client = try await connect(server)

        keypad.holdReplies(to: [KeypadMethod.keyLights])
        let inFlight = Task {
            try await client.callTool(name: "set_key_lights", arguments: ["lights": [["key": 1, "color": "#FF0000"]]])
        }
        #expect(await eventually { keypad.requests.contains { $0.method == KeypadMethod.keyLights } })
        let queued = Task {
            try await client.callTool(name: "set_key_lights", arguments: ["lights": [["key": 2, "color": "#00FF00"]]])
        }
        #expect(await eventually { await session.lights.light(forKey: 2) != nil })
        server.close()
        #expect(await finishes(running))

        // Both calls have left the lighting queue, so a new write goes out at once
        // and carries the light that the canceled call left pending.
        keypad.holdReplies(to: [])
        let blue = KeyLight(key: 3, color: LightColor(packed: 0x0000FF))
        let next = Task { try await session.setKeyLights([blue]) }
        #expect(await finishes(next))
        #expect(keypad.keyLights[3] == blue)
        #expect(keypad.keyLights[2] == KeyLight(key: 2, color: LightColor(packed: 0x00FF00)))
        inFlight.cancel()
        queued.cancel()
        await client.disconnect()
        await session.stop()
    }

    @Test("A client that disconnects ends its wait_for_input call")
    func disconnectEndsToolCall() async throws {
        try await withServer { server, session, _ in
            let fd = try connectLoopback(port: server.port)
            let body = #"""
                {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait_for_input","arguments":{"timeout":60}}}
                """#
            var request = "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:\(server.port)\r\n"
            request += "Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n"
            request += "Content-Length: \(body.utf8.count)\r\n\r\n\(body)"
            let bytes = Array(request.utf8)
            #expect(write(fd, bytes, bytes.count) == bytes.count)
            #expect(await eventually { await session.subscriberCount == 1 })
            close(fd)
            #expect(await eventually { await session.subscriberCount == 0 })
        }
    }

    /// Sends a raw HTTP request with the given extra header lines and returns the status code.
    private func status(port: Int, headers: [(String, String)]) throws -> Int? {
        let fd = try connectLoopback(port: port)
        defer { close(fd) }
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        let body = #"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#
        var request = "POST /mcp HTTP/1.1\r\n"
        for (name, value) in headers { request += "\(name): \(value)\r\n" }
        request += "Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n"
        request += "Content-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        let bytes = Array(request.utf8)
        guard write(fd, bytes, bytes.count) == bytes.count else { return nil }
        var buffer = [UInt8](repeating: 0, count: 64)
        let count = read(fd, &buffer, buffer.count)
        guard count > 0 else { return nil }
        let line = String(decoding: buffer.prefix(count), as: UTF8.self)
        let parts = line.split(separator: " ")
        return parts.count > 1 ? Int(parts[1]) : nil
    }

    @Test("Checks the Host header, and combines duplicate headers whatever their case")
    func hostsAndDuplicateHeaders() async throws {
        try await withServer { server, _, _ in
            let port = server.port
            let allowedHost = "127.0.0.1:\(port)"
            let allowedOrigin = "http://127.0.0.1:\(port)"
            let cases: [(headers: [(String, String)], status: Int)] = [
                ([("Host", allowedHost)], 200),
                ([("Host", "localhost:\(port)")], 200),
                ([("Host", "evil.example:\(port)")], 421),
                ([("Host", allowedHost), ("host", "evil.example")], 421),
                ([("host", "evil.example"), ("Host", allowedHost)], 421),
                ([("Host", allowedHost), ("Origin", allowedOrigin), ("origin", "https://evil.example")], 403),
                ([("Host", allowedHost), ("origin", "https://evil.example"), ("Origin", allowedOrigin)], 403),
            ]
            for (headers, expected) in cases {
                let actual = try status(port: port, headers: headers)
                #expect(actual == expected, "\(headers)")
            }
        }
    }

    @Test("Rejects foreign origins and other paths")
    func origins() async throws {
        try await withServer { server, _, _ in
            let body = Data(#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.utf8)
            var request = URLRequest(url: server.url)
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue("https://evil.example", forHTTPHeaderField: "Origin")
            let (_, forbidden) = try await URLSession.shared.data(for: request)
            #expect((forbidden as? HTTPURLResponse)?.statusCode == 403)

            request.setValue("http://127.0.0.1:\(server.port)", forHTTPHeaderField: "Origin")
            let (_, allowed) = try await URLSession.shared.data(for: request)
            #expect((allowed as? HTTPURLResponse)?.statusCode == 200)

            var other = request
            other.url = URL(string: "http://127.0.0.1:\(server.port)/other")
            let (_, missing) = try await URLSession.shared.data(for: other)
            #expect((missing as? HTTPURLResponse)?.statusCode == 404)

            var get = URLRequest(url: server.url)
            get.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            let (_, notAllowed) = try await URLSession.shared.data(for: get)
            #expect((notAllowed as? HTTPURLResponse)?.statusCode == 405)
        }
    }
}
