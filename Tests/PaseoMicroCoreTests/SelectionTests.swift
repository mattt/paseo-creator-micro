import CreatorMicro
import Foundation
@testable import PaseoMicroCore
import Testing

@Suite("Selection")
struct SelectionTests {
    @Test("Stores, replaces, and clears a workspace ID")
    func storesAndClears() throws {
        let store = SelectionStore()
        #expect(store.workspaceID == nil)
        try store.set("ws_1")
        #expect(store.workspaceID == "ws_1")
        try store.set("ws_2")
        #expect(store.workspaceID == "ws_2")
        try store.set(nil)
        #expect(store.workspaceID == nil)
    }

    @Test(
        "Refuses an empty, long, or control-character ID and keeps the stored one",
        arguments: [
            ("", SelectionError.empty),
            (String(repeating: "a", count: 257), SelectionError.tooLong(257)),
            ("ws\n1", SelectionError.controlCharacter),
            ("ws\u{0}", SelectionError.controlCharacter),
        ]
    )
    func refuses(id: String, error: SelectionError) throws {
        let store = SelectionStore()
        try store.set("ws_1")
        #expect(throws: error) { try store.set(id) }
        #expect(store.workspaceID == "ws_1")
    }

    @Test("Accepts an ID of exactly the maximum length")
    func maximumLength() throws {
        let store = SelectionStore()
        try store.set(String(repeating: "a", count: SelectionStore.maximumLength))
        #expect(store.workspaceID?.count == SelectionStore.maximumLength)
    }

    @Test("Encodes and decodes setSelection, and the selection in hello")
    func codable() throws {
        let set = BridgeCommand(id: 3, .setSelection(workspaceID: "ws_1"))
        #expect(
            String(decoding: set.line(), as: UTF8.self) == #"{"id":3,"type":"setSelection","workspaceId":"ws_1"}"#
                + "\n"
        )
        let clear = BridgeCommand(.setSelection(workspaceID: nil))
        #expect(String(decoding: clear.line(), as: UTF8.self) == #"{"type":"setSelection","workspaceId":null}"# + "\n")
        for command in [set, clear] {
            #expect(try JSONDecoder().decode(BridgeCommand.self, from: command.line()) == command)
        }
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(BridgeCommand.self, from: Data(#"{"type":"setSelection"}"#.utf8))
        }
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(BridgeCommand.self, from: Data(#"{"type":"setSelection","workspaceId":7}"#.utf8))
        }

        let hello = BridgeMessage.hello(
            protocolVersion: 1,
            appVersion: "0.1.0",
            keypad: .disconnected,
            selectedWorkspaceID: "ws_1"
        )
        #expect(String(decoding: hello.line(), as: UTF8.self).contains(#""selectedWorkspaceId":"ws_1""#))
        #expect(try JSONDecoder().decode(BridgeMessage.self, from: hello.line()) == hello)
        let bare = BridgeMessage.hello(protocolVersion: 1, appVersion: "0.1.0", keypad: .disconnected)
        #expect(!String(decoding: bare.line(), as: UTF8.self).contains("selectedWorkspaceId"))
        #expect(try JSONDecoder().decode(BridgeMessage.self, from: bare.line()) == bare)
    }

    @Test("Returns the stored selection in hello, to later clients and from a new server")
    func bridgeKeepsSelection() async throws {
        let session = KeypadSession(transport: EmulatedKeypad())
        let store = SelectionStore()
        let path = temporarySocketPath()
        defer {
            try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        }
        let bridge = try await BridgeServer.bind(
            path: path,
            session: session,
            interface: RecordingInterface(),
            selection: store
        )
        let running = Task { try await bridge.run() }

        func hello() async throws -> String?? {
            try await BridgeClient.connect(path: path).run { messages, _ in
                var iterator = messages.makeAsyncIterator()
                guard case .hello(_, _, _, let selected) = try await iterator.next() else { return nil }
                return .some(selected)
            }
        }

        #expect(try await hello() == .some(nil))
        let results = try await BridgeClient.connect(path: path).run { messages, writer in
            var iterator = messages.makeAsyncIterator()
            _ = try await iterator.next()
            try await writer.send(BridgeCommand(id: 1, .setSelection(workspaceID: "ws_1")))
            try await writer.send(rawLine: #"{"type":"setSelection","id":2,"workspaceId":""}"#)
            try await writer.send(rawLine: #"{"type":"setSelection","id":3}"#)
            var results: [Int: Bool] = [:]
            while results.count < 3, let message = try await iterator.next() {
                if case .result(let id, let ok, _) = message { results[id] = ok }
            }
            return results
        }
        #expect(results == [1: true, 2: false, 3: false])
        #expect(store.workspaceID == "ws_1")
        #expect(try await hello() == .some("ws_1"))

        bridge.close()
        #expect(await finishes(running))
        let next = try await BridgeServer.bind(
            path: path,
            session: session,
            interface: RecordingInterface(),
            selection: store
        )
        let nextRunning = Task { try await next.run() }
        #expect(try await hello() == .some("ws_1"))

        try await BridgeClient.connect(path: path).run { messages, writer in
            var iterator = messages.makeAsyncIterator()
            _ = try await iterator.next()
            try await writer.send(BridgeCommand(id: 4, .setSelection(workspaceID: nil)))
            while let message = try await iterator.next() {
                if case .result(4, let ok, _) = message {
                    #expect(ok)
                    break
                }
            }
        }
        #expect(try await hello() == .some(nil))
        next.close()
        #expect(await finishes(nextRunning))
    }
}
