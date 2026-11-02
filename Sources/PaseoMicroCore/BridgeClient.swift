import Foundation
import NIOCore
import NIOPosix

/// A client of the app's bridge socket.
///
/// The `micro` command and the tests use it;
/// the Paseo plugin speaks the same protocol from TypeScript.
///
/// ```swift
/// let client = try await BridgeClient.connect(path: BridgeServer.defaultPath)
/// try await client.run { messages, client in
///     try await client.send(BridgeCommand(id: 1, .getState))
///     for try await message in messages { print(message) }
/// }
/// ```
public struct BridgeClient: Sendable {
    private let channel: NIOAsyncChannel<ByteBuffer, ByteBuffer>

    /// A writer for commands, valid inside ``run(_:)``.
    public struct Writer: Sendable {
        fileprivate let outbound: NIOAsyncChannelOutboundWriter<ByteBuffer>

        /// Sends a command.
        ///
        /// - Parameter command: The command.
        /// - Throws: A channel error if the connection is closed.
        public func send(_ command: BridgeCommand) async throws {
            try await outbound.write(ByteBuffer(bytes: command.line()))
        }

        /// Sends one raw line, without validating it.
        ///
        /// - Parameter line: The line, without its newline.
        /// - Throws: A channel error if the connection is closed.
        public func send(rawLine line: String) async throws {
            try await outbound.write(ByteBuffer(string: line + "\n"))
        }
    }

    /// The messages from the app, decoded.
    public struct Messages: AsyncSequence, Sendable {
        public typealias Element = BridgeMessage

        fileprivate let inbound: NIOAsyncChannelInboundStream<ByteBuffer>

        public struct AsyncIterator: AsyncIteratorProtocol {
            fileprivate var lines: NIOAsyncChannelInboundStream<ByteBuffer>.AsyncIterator

            public mutating func next() async throws -> BridgeMessage? {
                guard let line = try await lines.next() else { return nil }
                return try JSONDecoder().decode(BridgeMessage.self, from: Data(line.readableBytesView))
            }
        }

        public func makeAsyncIterator() -> AsyncIterator {
            AsyncIterator(lines: inbound.makeAsyncIterator())
        }
    }

    /// Connects to the bridge.
    ///
    /// - Parameter path: The socket's path.
    /// - Returns: The connected client; call ``run(_:)`` to use it.
    /// - Throws: A system error if nothing listens on the path.
    public static func connect(path: String) async throws -> BridgeClient {
        let channel = try await ClientBootstrap(group: MultiThreadedEventLoopGroup.singleton)
            .connect(unixDomainSocketPath: path) { channel in
                channel.eventLoop.makeCompletedFuture {
                    try channel.pipeline.syncOperations.addHandler(ByteToMessageHandler(LineDecoder()))
                    return try NIOAsyncChannel<ByteBuffer, ByteBuffer>(wrappingChannelSynchronously: channel)
                }
            }
        return BridgeClient(channel: channel)
    }

    /// Uses the connection, then closes it.
    ///
    /// - Parameter body: A closure that receives the app's messages and a writer for commands.
    /// - Returns: What the closure returns.
    /// - Throws: What the closure throws.
    public func run<Result: Sendable>(
        _ body: (Messages, Writer) async throws -> Result
    ) async throws -> Result {
        try await channel.executeThenClose { inbound, outbound in
            try await body(Messages(inbound: inbound), Writer(outbound: outbound))
        }
    }
}
