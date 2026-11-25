import NIOCore
import Synchronization

/// The connections a server has accepted, including those still waiting for its accept loop.
final class ConnectionSet<Inbound: Sendable, Outbound: Sendable>: Sendable {
    typealias Connection = NIOAsyncChannel<Inbound, Outbound>

    private struct State {
        var closed = false
        var channels: [ObjectIdentifier: Connection] = [:]
    }

    private let state = Mutex(State())

    var isClosed: Bool { state.withLock { $0.closed } }

    /// Wraps an accepted channel on its event loop, or closes it if the server has stopped.
    func wrap(_ channel: any Channel) throws -> Connection {
        let id = ObjectIdentifier(channel)
        do {
            let connection = try state.withLock { state in
                guard !state.closed else { throw ChannelError.ioOnClosedChannel }
                let connection = try Connection(wrappingChannelSynchronously: channel)
                state.channels[id] = connection
                return connection
            }
            // The accept loop can drop a buffered connection during shutdown.
            // Keep its writer alive until NIO finishes it when the child channel closes.
            channel.closeFuture.whenComplete { _ in
                _ = self.state.withLock { $0.channels.removeValue(forKey: id) }
            }
            return connection
        } catch {
            channel.close(promise: nil)
            throw error
        }
    }

    /// Closes every connection and prevents the server from accepting more.
    func closeAll() {
        let channels = state.withLock { state in
            state.closed = true
            return Array(state.channels.values)
        }
        for connection in channels { connection.channel.close(promise: nil) }
    }
}
