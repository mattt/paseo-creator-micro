import CreatorMicro
import Foundation
import PaseoMicroCore

/// `micro`: a command-line client of Paseo Micro's bridge.
@main
struct Micro {
    static let usage = """
        usage: micro [--socket <path>] <command>

        commands:
          state                       Print the keypad's state.
          watch                       Print every message from the app until interrupted.
          lights <key>=<light>...     Set key lights, such as 0=#FF2D2D,breathing 1=#00FF00,solid,0.5
          zones [--keys <light>] [--ambient <light>]
                                      Set the key backlight and the ambient ring.
          clear                       Turn off every light.

        A <light> is <color>[,<effect>[,<brightness>[,<speed>]]].
        Effects: \(LightEffect.allCases.map(\.name).joined(separator: ", ")).
        The socket defaults to $PASEO_MICRO_BRIDGE_SOCKET, then
        ~/Library/Application Support/PaseoMicro/bridge.sock.
        """

    struct UsageError: Error, CustomStringConvertible {
        var description: String
    }

    static func main() async {
        var arguments = Array(CommandLine.arguments.dropFirst())
        var path = ProcessInfo.processInfo.environment["PASEO_MICRO_BRIDGE_SOCKET"] ?? BridgeServer.defaultPath
        if let index = arguments.firstIndex(of: "--socket") {
            guard index + 1 < arguments.count else { fail(UsageError(description: "--socket needs a path")) }
            path = arguments[index + 1]
            arguments.removeSubrange(index ... index + 1)
        }
        guard let command = arguments.first, !["-h", "--help", "help"].contains(command) else {
            print(usage)
            exit(arguments.isEmpty ? 64 : 0)
        }
        do {
            let rest = Array(arguments.dropFirst())
            switch command {
            case "state":
                try await state(path: path)
            case "watch":
                try await watch(path: path)
            case "lights":
                try await send(.setKeyLights(try parseKeyLights(rest)), path: path)
            case "zones":
                let (keys, ambient) = try parseZones(rest)
                try await send(.setZones(keys: keys, ambient: ambient), path: path)
            case "clear":
                try await send(.clearLights, path: path)
            default:
                throw UsageError(description: "unknown command \(command)\n\n\(usage)")
            }
        } catch {
            fail(error)
        }
    }

    static func fail(_ error: any Error) -> Never {
        FileHandle.standardError.write(Data("micro: \(error)\n".utf8))
        exit(error is UsageError ? 64 : 1)
    }

    // MARK: - Commands

    static func state(path: String) async throws {
        let client = try await BridgeClient.connect(path: path)
        try await client.run { messages, _ in
            for try await message in messages {
                if case .hello(_, _, let keypad, _) = message {
                    print(try json(keypad, pretty: true))
                    return
                }
            }
        }
    }

    static func watch(path: String) async throws {
        let client = try await BridgeClient.connect(path: path)
        try await client.run { messages, _ in
            for try await message in messages {
                print(try json(message, pretty: false))
                fflush(stdout)
            }
        }
    }

    static func send(_ action: BridgeCommand.Action, path: String) async throws {
        let client = try await BridgeClient.connect(path: path)
        let error = try await client.run { messages, writer -> String? in
            try await writer.send(BridgeCommand(id: 1, action))
            for try await message in messages {
                if case .result(1, let ok, let error) = message {
                    return ok ? nil : (error ?? "failed")
                }
            }
            return "the app closed the connection"
        }
        if let error { throw UsageError(description: error) }
    }

    // MARK: - Parsing

    static func parseKeyLights(_ arguments: [String]) throws -> [KeyLight] {
        guard !arguments.isEmpty else { throw UsageError(description: "lights needs at least one <key>=<light>") }
        return try arguments.map { argument in
            let parts = argument.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2, let key = Int(parts[0]) else {
                throw UsageError(description: "expected <key>=<light>, not \(argument)")
            }
            let zone = try parseLight(parts[1])
            // Key lights default to speed 0.5, zones to 0.
            let speed = parts[1].split(separator: ",").count > 3 ? zone.speed : 0.5
            return KeyLight(key: key, color: zone.color, brightness: zone.brightness, effect: zone.effect, speed: speed)
        }
    }

    static func parseZones(_ arguments: [String]) throws -> (ZoneLight?, ZoneLight?) {
        var keys: ZoneLight?
        var ambient: ZoneLight?
        var iterator = arguments.makeIterator()
        while let flag = iterator.next() {
            guard let value = iterator.next() else { throw UsageError(description: "\(flag) needs a <light>") }
            switch flag {
            case "--keys": keys = try parseLight(value)
            case "--ambient": ambient = try parseLight(value)
            default: throw UsageError(description: "unknown option \(flag)")
            }
        }
        guard keys != nil || ambient != nil else { throw UsageError(description: "zones needs --keys or --ambient") }
        return (keys, ambient)
    }

    static func parseLight(_ text: String) throws -> ZoneLight {
        let parts = text.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
        guard let color = LightColor(hex: parts[0]) else { throw UsageError(description: "not a color: \(parts[0])") }
        var light = ZoneLight(color: color)
        if parts.count > 1 {
            guard let effect = LightEffect(name: parts[1]) else {
                throw UsageError(description: "unknown effect \(parts[1])")
            }
            light.effect = effect
        }
        if parts.count > 2 {
            guard let brightness = Double(parts[2]) else {
                throw UsageError(description: "not a brightness: \(parts[2])")
            }
            light = ZoneLight(color: light.color, effect: light.effect, brightness: brightness)
        }
        if parts.count > 3 {
            guard let speed = Double(parts[3]) else { throw UsageError(description: "not a speed: \(parts[3])") }
            light = ZoneLight(color: light.color, effect: light.effect, brightness: light.brightness, speed: speed)
        }
        return light
    }

    static func json(_ value: some Encodable, pretty: Bool) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting =
            pretty ? [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }
}
