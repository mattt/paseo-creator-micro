import NIOCore
import Synchronization

/// The open connections of a server, so that closing the server closes them too.
///
/// A server that waits for its connection tasks would otherwise wait
/// for every idle client to leave before it stops.
final class ConnectionSet: Sendable {
    private struct State {
        var closed = false
        var channels: [ObjectIdentifier: any Channel] = [:]
    }

    private let state = Mutex(State())

    /// Adds a connection, or closes it at once if the server has closed.
    ///
    /// - Parameter channel: The connection's channel.
    /// - Returns: `true` if the connection was added; `false` if it was closed.
    func insert(_ channel: any Channel) -> Bool {
        let added = state.withLock { state in
            guard !state.closed else { return false }
            state.channels[ObjectIdentifier(channel)] = channel
            return true
        }
        if !added { channel.close(promise: nil) }
        return added
    }

    /// Removes a connection that has ended.
    ///
    /// - Parameter channel: The connection's channel.
    func remove(_ channel: any Channel) {
        _ = state.withLock { $0.channels.removeValue(forKey: ObjectIdentifier(channel)) }
    }

    /// Closes every connection, and every connection added later.
    func closeAll() {
        let channels = state.withLock { state in
            state.closed = true
            return Array(state.channels.values)
        }
        for channel in channels { channel.close(promise: nil) }
    }
}
