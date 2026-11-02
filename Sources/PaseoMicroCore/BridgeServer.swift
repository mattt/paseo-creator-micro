import CreatorMicro
import Darwin
import Foundation
import NIOCore
import NIOPosix
import Synchronization
import os

private let logger = Logger(subsystem: "co.dododo.paseo-micro", category: "bridge")

/// A client connected to the bridge.
public struct BridgeClientInfo: Sendable, Hashable, Identifiable {
    /// A unique identifier for the connection.
    public var id: UUID
    /// The client's process identifier, if the system reports it.
    public var processID: Int32?
    /// The client's process name, if known.
    public var processName: String?
    /// When the client connected.
    public var connectedAt: Date
}

/// Errors from the bridge.
public enum BridgeError: Error, Sendable, Hashable, CustomStringConvertible {
    /// Another program already listens on the socket.
    case alreadyRunning(String)
    /// The socket path is too long for a Unix domain socket.
    case pathTooLong(String)
    /// Something other than a socket exists at the path.
    case notSocket(String)
    /// Another user owns the socket at the path.
    case notOwned(String)
    /// The socket's folder is not a folder that the current user owns with mode 0700.
    case unsafeFolder(String, String)
    /// A connection to the existing socket failed with an error other than "refused".
    case probeFailed(String, Int32)

    public var description: String {
        switch self {
        case .alreadyRunning(let path): "Another program already listens on \(path)"
        case .pathTooLong(let path): "The socket path is too long: \(path)"
        case .notSocket(let path): "\(path) exists and is not a socket; move it or choose another path"
        case .notOwned(let path): "Another user owns the socket \(path)"
        case .unsafeFolder(let folder, let reason):
            "The socket's folder \(folder) is unsafe: \(reason). It must be a folder that you own with mode 0700."
        case .probeFailed(let path, let code):
            "Could not check whether a program listens on \(path): \(String(cString: strerror(code)))"
        }
    }
}

/// The Unix domain socket that connects the Paseo plugin to the app.
///
/// Each client receives a `hello`, then `keypad` and `input` messages as they happen,
/// and may send commands, one JSON object per line.
/// The socket has mode 0600, in a folder that the current user owns with mode 0700.
/// The server removes only its own socket file,
/// so that a new server on the same path keeps its socket when an old one finishes.
///
/// ```swift
/// let bridge = try await BridgeServer.bind(path: BridgeServer.defaultPath, session: session)
/// try await bridge.run()
/// ```
public final class BridgeServer: Sendable {
    /// The default socket path: `~/Library/Application Support/PaseoMicro/bridge.sock`.
    public static var defaultPath: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/PaseoMicro/bridge.sock").path
    }

    /// The socket's path.
    public let path: String

    /// The radial menu that clients set and the joystick drives.
    public let radialMenu: RadialMenuController

    /// The workspace that a client selected, which each `hello` returns.
    public let selection: SelectionStore

    private typealias Connection = (channel: NIOAsyncChannel<ByteBuffer, ByteBuffer>, processID: Int32?)

    private let serverChannel: NIOAsyncChannel<Connection, Never>
    private let session: KeypadSession
    private let interface: any InterfaceDriver
    private let events: EventSender
    private let appVersion: String
    private let connected = Mutex<[UUID: BridgeClientInfo]>([:])
    private let onClientsChange: (@Sendable ([BridgeClientInfo]) -> Void)?
    private let clientQueueLimit: Int
    private let connections = ConnectionSet()
    private let socketFile: SocketFile

    private init(
        path: String,
        socketFile: SocketFile,
        serverChannel: NIOAsyncChannel<Connection, Never>,
        session: KeypadSession,
        interface: any InterfaceDriver,
        radialMenu: RadialMenuController,
        selection: SelectionStore,
        appVersion: String,
        clientQueueLimit: Int,
        onClientsChange: (@Sendable ([BridgeClientInfo]) -> Void)?
    ) {
        self.path = path
        self.radialMenu = radialMenu
        self.selection = selection
        self.socketFile = socketFile
        self.serverChannel = serverChannel
        self.session = session
        self.interface = interface
        self.events = EventSender(interface: interface)
        self.appVersion = appVersion
        self.clientQueueLimit = max(1, clientQueueLimit)
        self.onClientsChange = onClientsChange
    }

    /// Creates the socket and starts to listen.
    ///
    /// The socket's folder must be a folder that the current user owns with mode 0700;
    /// the server creates it with that mode if it does not exist.
    /// A stale socket file from an earlier run is replaced
    /// only if it is a socket that the current user owns and connecting to it is refused.
    /// Any other file at the path stays as it is.
    ///
    /// - Parameters:
    ///   - path: The socket's path; at most 103 bytes.
    ///   - session: The keypad session that the bridge serves.
    ///   - interface: The driver for `openURL`, `sendShortcut`, and `scroll`.
    ///   - radialMenu: The radial menu that `setRadialMenu` sets and the joystick drives.
    ///   - selection: The store of the selected workspace that `setSelection` sets and `hello` returns;
    ///     pass the same store to a new server so that the selection outlives the old one.
    ///   - appVersion: The version in the `hello` message.
    ///   - clientQueueLimit: The most messages that may wait for one client;
    ///     a client that falls further behind is disconnected, so that no message is lost without notice.
    ///   - onClientsChange: Called with the connected clients whenever they change.
    /// - Returns: The listening server; call ``run()`` to accept connections.
    /// - Throws: ``BridgeError/alreadyRunning(_:)`` if another program listens on the path,
    ///   ``BridgeError/pathTooLong(_:)``, ``BridgeError/notSocket(_:)``, ``BridgeError/notOwned(_:)``,
    ///   ``BridgeError/unsafeFolder(_:_:)``, ``BridgeError/probeFailed(_:_:)``, or a system error.
    public static func bind(
        path: String,
        session: KeypadSession,
        interface: any InterfaceDriver = SystemInterfaceDriver(),
        radialMenu: RadialMenuController = RadialMenuController(),
        selection: SelectionStore = SelectionStore(),
        appVersion: String = paseoMicroVersion,
        clientQueueLimit: Int = 1024,
        onClientsChange: (@Sendable ([BridgeClientInfo]) -> Void)? = nil
    ) async throws -> BridgeServer {
        guard path.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
            throw BridgeError.pathTooLong(path)
        }
        try prepareFolder(URL(fileURLWithPath: path).deletingLastPathComponent().path)
        try removeStaleSocket(at: path)
        // Bind the socket here rather than with `bind(unixDomainSocketPath:)`:
        // NIO removes a socket path that it bound when the channel closes, by name,
        // which can remove a newer server's socket at the same path.
        // With a socket that it did not bind, NIO leaves the file to `SocketFile`.
        let fd = try bindSocket(at: path)
        let socketFile: SocketFile
        do {
            socketFile = try SocketFile(path: path)
            guard chmod(path, 0o600) == 0 else {
                let error = POSIXError.current
                socketFile.remove()
                throw error
            }
        } catch {
            Darwin.close(fd)
            throw error
        }
        let channel: NIOAsyncChannel<Connection, Never>
        do {
            channel = try await ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton)
                .bind(fd) { channel in
                    channel.eventLoop.makeCompletedFuture {
                        let processID = try? channel.syncOptions?.getOption(
                            ChannelOptions.Types.SocketOption(level: SOL_LOCAL, name: LOCAL_PEERPID)
                        )
                        try channel.pipeline.syncOperations.addHandler(ByteToMessageHandler(LineDecoder()))
                        let wrapped = try NIOAsyncChannel<ByteBuffer, ByteBuffer>(
                            wrappingChannelSynchronously: channel
                        )
                        return Connection(channel: wrapped, processID: processID)
                    }
                }
        } catch {
            socketFile.remove()
            throw error
        }
        return BridgeServer(
            path: path,
            socketFile: socketFile,
            serverChannel: channel,
            session: session,
            interface: interface,
            radialMenu: radialMenu,
            selection: selection,
            appVersion: appVersion,
            clientQueueLimit: clientQueueLimit,
            onClientsChange: onClientsChange
        )
    }

    /// The clients connected now, oldest first.
    public var clients: [BridgeClientInfo] {
        connected.withLock { $0.values.sorted { $0.connectedAt < $1.connectedAt } }
    }

    /// Accepts connections until the task is canceled or ``close()`` is called.
    ///
    /// When it stops, it closes every client connection, waits for them to end,
    /// and removes the socket file if it is still this server's.
    ///
    /// - Throws: A system error if accepting fails.
    public func run() async throws {
        defer { close() }
        try await withTaskCancellationHandler {
            try await serverChannel.executeThenClose { inbound in
                try await withThrowingDiscardingTaskGroup { group in
                    for try await connection in inbound {
                        group.addTask {
                            await self.serve(connection.channel, processID: connection.processID)
                        }
                    }
                    self.connections.closeAll()
                    group.cancelAll()
                }
            }
        } onCancel: {
            close()
        }
    }

    /// Stops accepting connections, closes every client connection,
    /// and removes the socket file if it is still this server's; ``run()`` then returns.
    public func close() {
        serverChannel.channel.close(promise: nil)
        connections.closeAll()
        socketFile.remove()
    }

    // MARK: - Connections

    private func serve(_ channel: NIOAsyncChannel<ByteBuffer, ByteBuffer>, processID: Int32?) async {
        guard connections.insert(channel.channel) else { return }
        defer { connections.remove(channel.channel) }
        let id = UUID()
        let info = BridgeClientInfo(
            id: id,
            processID: processID,
            processName: processID.flatMap(Self.processName),
            connectedAt: Date()
        )
        changeClients { $0[id] = info }
        defer { changeClients { $0.removeValue(forKey: id) } }
        defer { radialMenu.clear(client: id) }

        try? await channel.executeThenClose { inbound, outbound in
            let (lines, sink) = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingOldest(clientQueueLimit))
            let outbox = Outbox(sink: sink, channel: channel.channel, client: id)
            let updates = await session.updates()
            let state = await session.state
            self.radialMenu.keypadChanged(state)
            outbox.send(
                BridgeMessage.hello(
                    protocolVersion: bridgeProtocolVersion,
                    appVersion: appVersion,
                    keypad: state,
                    selectedWorkspaceID: selection.workspaceID
                )
            )

            await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    for await line in lines {
                        try await outbound.write(ByteBuffer(bytes: line))
                    }
                }
                group.addTask {
                    do {
                        for try await event in updates {
                            switch event {
                            case .state(let state):
                                self.radialMenu.keypadChanged(state)
                                outbox.send(.keypad(state))
                            case .input(let input):
                                // A key press or dial click that cancels the open radial menu,
                                // and its release, do only that for the menu's owner.
                                if self.radialMenu.intercept(input, client: id) { continue }
                                outbox.send(.input(input))
                                // Only the menu's owner picks, so each position counts once.
                                if case .joystick(let joystick) = input,
                                    let slot = self.radialMenu.handle(joystick, client: id)
                                {
                                    outbox.send(.radialPick(slot: slot))
                                }
                            case .lights: break
                            }
                        }
                    } catch {
                        // The client missed events, perhaps a key release: disconnect it,
                        // so that it resets what it holds and starts again from a new `hello`.
                        outbox.disconnect(reason: "it missed keypad events")
                    }
                }
                do {
                    for try await line in inbound {
                        await self.handle(line: Data(line.readableBytesView), outbox: outbox)
                    }
                } catch {
                    // The client went away or sent a line that is too long.
                }
                sink.finish()
                group.cancelAll()
            }
        }
    }

    private func handle(line: Data, outbox: Outbox) async {
        guard !line.allSatisfy({ $0 == UInt8(ascii: " ") || $0 == UInt8(ascii: "\t") }) else { return }
        let command: BridgeCommand
        do {
            command = try JSONDecoder().decode(BridgeCommand.self, from: line)
        } catch {
            // Answer a malformed command only when its id can be read.
            struct Envelope: Decodable { var id: Int? }
            if let id = (try? JSONDecoder().decode(Envelope.self, from: line))?.id {
                outbox.send(.result(id: id, ok: false, error: Self.describe(error)))
            }
            return
        }
        do {
            try await perform(command.action, outbox: outbox)
            if let id = command.id { outbox.send(.result(id: id, ok: true, error: nil)) }
        } catch {
            if let id = command.id {
                outbox.send(.result(id: id, ok: false, error: Self.describe(error)))
            }
        }
    }

    private func perform(_ action: BridgeCommand.Action, outbox: Outbox) async throws {
        switch action {
        case .setKeyLights(let lights):
            try await session.setKeyLights(lights)
        case .setZones(let keys, let ambient):
            try await session.setZones(keys: keys, ambient: ambient)
        case .clearLights:
            try await session.clearLights()
        case .getState:
            outbox.send(.keypad(await session.state))
        case .openURL(let text):
            try await interface.open(PaseoLink.validate(text))
        case .sendShortcut(let text, let bundleID, let activate):
            try await events.send(Shortcut(text), bundleID: bundleID, activate: activate)
        case .scroll(let lines, let bundleID, let activate, let fromTop):
            let scroll = try ScrollRequest(lines: lines, fromTop: fromTop ?? ScrollRequest.defaultFromTop)
            try await events.scroll(scroll, bundleID: bundleID, activate: activate)
        case .scrollToEdge(let edge, let bundleID, let activate, let fromTop):
            let scroll = try ScrollRequest(edge: edge, fromTop: fromTop ?? ScrollRequest.defaultFromTop)
            try await events.scroll(scroll, bundleID: bundleID, activate: activate)
        case .setRadialMenu(let menu):
            try radialMenu.set(menu, client: outbox.client)
        case .clearRadialMenu:
            radialMenu.clear(client: outbox.client)
        case .setSelection(let workspaceID):
            try selection.set(workspaceID)
        }
    }

    private func changeClients(_ change: (inout [UUID: BridgeClientInfo]) -> Void) {
        let clients = connected.withLock { clients in
            change(&clients)
            return clients.values.sorted { $0.connectedAt < $1.connectedAt }
        }
        onClientsChange?(clients)
    }

    // MARK: - Helpers

    static func describe(_ error: any Error) -> String {
        switch error {
        case let error as DecodingError:
            switch error {
            case .dataCorrupted(let context), .typeMismatch(_, let context), .valueNotFound(_, let context):
                return "Invalid command: \(context.debugDescription)"
            case .keyNotFound(let key, _):
                return "Invalid command: missing \"\(key.stringValue)\""
            @unknown default:
                return "Invalid command"
            }
        case let error as CustomStringConvertible:
            return error.description
        default:
            return error.localizedDescription
        }
    }

    private static func processName(_ pid: Int32) -> String? {
        var buffer = [UInt8](repeating: 0, count: 256)
        let length = proc_name(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return String(decoding: buffer.prefix(Int(length)), as: UTF8.self)
    }

    /// Creates the socket's folder with mode 0700 if it is missing,
    /// and checks that it is a folder that the current user owns with mode 0700.
    private static func prepareFolder(_ folder: String) throws {
        var info = stat()
        if lstat(folder, &info) != 0 {
            guard errno == ENOENT else { throw POSIXError.current }
            try FileManager.default.createDirectory(
                atPath: folder,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            guard lstat(folder, &info) == 0 else { throw POSIXError.current }
        }
        guard info.st_mode & S_IFMT == S_IFDIR else { throw BridgeError.unsafeFolder(folder, "it is not a folder") }
        guard info.st_uid == geteuid() else { throw BridgeError.unsafeFolder(folder, "another user owns it") }
        let mode = info.st_mode & 0o777
        guard mode == 0o700 else {
            let octal = String(mode, radix: 8)
            throw BridgeError.unsafeFolder(
                folder,
                "its mode is \(String(repeating: "0", count: max(0, 4 - octal.count)) + octal), not 0700"
            )
        }
    }

    /// Removes a socket file that an earlier run left behind.
    ///
    /// Only a socket that the current user owns, and on which a connection is refused, is removed.
    private static func removeStaleSocket(at path: String) throws {
        var info = stat()
        guard lstat(path, &info) == 0 else {
            if errno == ENOENT { return }
            throw POSIXError.current
        }
        guard info.st_mode & S_IFMT == S_IFSOCK else { throw BridgeError.notSocket(path) }
        guard info.st_uid == geteuid() else { throw BridgeError.notOwned(path) }
        switch connectError(path) {
        case 0:
            throw BridgeError.alreadyRunning(path)
        case ECONNREFUSED:
            guard unlink(path) == 0 || errno == ENOENT else { throw POSIXError.current }
        case ENOENT:
            // Another process removed the socket after the check.
            return
        case let code:
            throw BridgeError.probeFailed(path, code)
        }
    }

    /// Creates a Unix domain socket and binds it to a path; the caller listens on it.
    ///
    /// - Returns: The socket's descriptor.
    /// - Throws: ``BridgeError/alreadyRunning(_:)`` if a file appeared at the path, or a system error.
    private static func bindSocket(at path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError.current }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: path.utf8.prefix(raw.count - 1))
        }
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, length) }
        }
        guard result == 0 else {
            let code = errno
            Darwin.close(fd)
            if code == EADDRINUSE { throw BridgeError.alreadyRunning(path) }
            throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
        }
        return fd
    }

    /// Tries to connect to a socket path.
    ///
    /// - Returns: 0 if a program accepts the connection, or else the `errno` of the failure.
    private static func connectError(_ path: String) -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return errno }
        defer { Darwin.close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: path.utf8.prefix(raw.count - 1))
        }
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, length) }
        }
        return result == 0 ? 0 : errno
    }
}

/// The messages that wait for one bridge client, up to a limit.
///
/// When a client falls so far behind that the queue is full,
/// the bridge disconnects it rather than drop a message, such as a key release or a result,
/// without notice; the client can connect again and start from a new `hello`.
private struct Outbox: Sendable {
    let sink: AsyncStream<Data>.Continuation
    let channel: any Channel
    let client: UUID

    /// Queues a message, or disconnects the client if its queue is full.
    func send(_ message: BridgeMessage) {
        guard case .dropped = sink.yield(message.line()) else { return }
        disconnect(reason: "its queue is full")
    }

    /// Disconnects the client, because it would otherwise miss a message.
    func disconnect(reason: String) {
        logger.error("Disconnecting bridge client \(client, privacy: .public): \(reason, privacy: .public)")
        sink.finish()
        channel.close(promise: nil)
    }
}

/// A socket file that a server created, identified by device, inode, and creation time.
///
/// The server removes the file at most once, and only while the path still names the same file,
/// so that it never removes a socket that a newer server created at the same path.
private final class SocketFile: Sendable {
    private struct Identity: Equatable {
        var device: dev_t
        var inode: ino_t
        var birthSeconds: Int
        var birthNanoseconds: Int

        init?(path: String) {
            var info = stat()
            guard lstat(path, &info) == 0 else { return nil }
            device = info.st_dev
            inode = info.st_ino
            birthSeconds = info.st_birthtimespec.tv_sec
            birthNanoseconds = info.st_birthtimespec.tv_nsec
        }
    }

    private let path: String
    private let identity: Identity
    private let removed = Mutex(false)

    /// Records the identity of the file at a path.
    ///
    /// - Throws: A system error if the path does not exist.
    init(path: String) throws {
        guard let identity = Identity(path: path) else { throw POSIXError.current }
        self.path = path
        self.identity = identity
    }

    /// Removes the file if the path still names it; later calls do nothing.
    func remove() {
        removed.withLock { removed in
            guard !removed else { return }
            removed = true
            if Identity(path: path) == identity { unlink(path) }
        }
    }
}

extension POSIXError {
    /// The error that `errno` holds now.
    static var current: POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}
