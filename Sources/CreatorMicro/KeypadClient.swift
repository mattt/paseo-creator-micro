import Foundation

/// An event from ``KeypadClient``.
public enum KeypadEvent: Sendable, Hashable {
    /// A keypad became available.
    case connected(KeypadDevice)
    /// The keypad went away.
    case disconnected
    /// The keypad sent an input: a key, the dial, or the joystick.
    case input(KeypadInput)
    /// The keypad sent a notification that is not an input.
    case notification(method: String, params: JSONValue?)
    /// The keypad replied to a request that this client did not send.
    ///
    /// The vendor interface is shared, so these replies belong to other programs,
    /// such as Work Louder's Input app.
    case foreignReply(id: Int)
}

/// A JSON-RPC client for the keypad, on top of a ``KeypadTransport``.
///
/// The client frames requests into reports, reassembles replies and notifications,
/// matches replies to requests by identifier, and fails requests that time out.
/// It never sends `fs.write`, `fs.writebin`, `fs.delete`, or any other `fs.` method
/// except `fs.list` and `fs.read`.
///
/// ```swift
/// let client = KeypadClient(transport: HIDTransport())
/// await client.start()
/// let version = try await client.version()
/// ```
public actor KeypadClient {
    /// The transport that carries the reports.
    public nonisolated let transport: any KeypadTransport

    /// The connected keypad, or `nil` when none is connected.
    public private(set) var device: KeypadDevice?

    private struct Pending {
        var method: String
        var continuation: CheckedContinuation<JSONValue, any Error>
        var timeout: Task<Void, Never>?
    }

    private var ids: RequestIDGenerator
    private var pending: [Int: Pending] = [:]
    private var reassembler = MessageReassembler()
    private var subscribers: [UUID: AsyncThrowingStream<KeypadEvent, any Error>.Continuation] = [:]
    private var eventTask: Task<Void, Never>?

    /// Creates a client.
    ///
    /// - Parameters:
    ///   - transport: The transport that carries the reports.
    ///   - firstRequestID: The first request identifier, from 1 to 999.
    public init(transport: any KeypadTransport, firstRequestID: Int = Int.random(in: 100 ..< 900)) {
        self.transport = transport
        self.ids = RequestIDGenerator(first: firstRequestID)
    }

    /// Starts the transport and begins to deliver events.
    ///
    /// Calling `start()` again while the client runs has no effect.
    public func start() {
        guard eventTask == nil else { return }
        let (stream, continuation) = AsyncStream<KeypadTransportEvent>.makeStream()
        transport.start { event in continuation.yield(event) }
        eventTask = Task {
            for await event in stream {
                self.handle(event)
            }
        }
    }

    /// Stops the transport, fails waiting requests, and ends every event stream.
    public func stop() {
        transport.stop()
        eventTask?.cancel()
        eventTask = nil
        if device != nil {
            device = nil
            broadcast(.disconnected)
        }
        failAll { .disconnected(method: $0) }
        reassembler.reset()
        for continuation in subscribers.values { continuation.finish() }
        subscribers.removeAll()
    }

    /// Returns a stream of events from now on.
    ///
    /// Each call returns a new stream; several streams may be active at once.
    /// The stream ends when the client stops or the caller stops iterating.
    /// It never drops an event without notice:
    /// when more than `bufferLimit` events wait for the caller,
    /// the stream delivers the events that it holds, then throws ``KeypadError/eventsOverflowed``.
    ///
    /// - Parameter bufferLimit: The most events that may wait for the caller.
    /// - Returns: The events, in order.
    public func events(bufferLimit: Int = 256) -> AsyncThrowingStream<KeypadEvent, any Error> {
        let (stream, continuation) = AsyncThrowingStream<KeypadEvent, any Error>.makeStream(
            bufferingPolicy: .bufferingOldest(max(1, bufferLimit))
        )
        let id = UUID()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeSubscriber(id) }
        }
        return stream
    }

    /// Sends a request and waits for its reply.
    ///
    /// - Parameters:
    ///   - method: The method name, such as `device.status`.
    ///   - params: The parameters, or `nil` to omit them.
    ///   - timeout: How long to wait for the reply.
    /// - Returns: The reply's `result`, or ``JSONValue/null`` if it has none.
    /// - Throws: ``KeypadError/forbiddenMethod(_:)`` for methods that write files,
    ///   ``KeypadError/notConnected`` when no keypad is connected,
    ///   ``KeypadError/timeout(method:)`` when no reply arrives in time,
    ///   ``KeypadError/disconnected(method:)`` when the keypad goes away first,
    ///   ``KeypadError/remote(method:error:)`` when the reply carries an error,
    ///   and `CancellationError` when the calling task is canceled.
    @discardableResult
    public func call(_ method: String, params: JSONValue? = nil, timeout: Duration = .seconds(3)) async throws
        -> JSONValue
    {
        guard KeypadMethod.isAllowed(method) else { throw KeypadError.forbiddenMethod(method) }
        guard device != nil else { throw KeypadError.notConnected }
        guard let id = ids.next(excluding: Set(pending.keys)) else { throw KeypadError.tooManyRequests }
        let reports = Report.rpcReports(for: RPCRequest(method: method, params: params, id: id).json.encoded())
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let timer = Task {
                    try? await Task.sleep(for: timeout)
                    guard !Task.isCancelled else { return }
                    self.finish(id, with: .failure(KeypadError.timeout(method: method)))
                }
                pending[id] = Pending(method: method, continuation: continuation, timeout: timer)
                Task {
                    do {
                        try await self.transport.send(reports)
                    } catch {
                        self.finish(id, with: .failure(error))
                    }
                }
            }
        } onCancel: {
            Task { await self.finish(id, with: .failure(CancellationError())) }
        }
    }

    /// Returns the firmware version from `sys.version`.
    ///
    /// - Returns: The version, such as `0.6.3`.
    /// - Throws: The errors of ``call(_:params:timeout:)``,
    ///   or ``KeypadError/unexpectedReply(method:reply:)`` if the reply has no version.
    public func version() async throws -> String {
        let result = try await call(KeypadMethod.version)
        guard let version = result["version"]?.stringValue else {
            throw KeypadError.unexpectedReply(method: KeypadMethod.version, reply: result)
        }
        return version
    }

    /// Returns the battery, layer, and firmware from `device.status`.
    ///
    /// - Returns: The status.
    /// - Throws: The errors of ``call(_:params:timeout:)``,
    ///   or ``KeypadError/unexpectedReply(method:reply:)`` if the reply is not an object.
    public func status() async throws -> KeypadStatus {
        let result = try await call(KeypadMethod.status)
        guard let status = KeypadStatus(result: result) else {
            throw KeypadError.unexpectedReply(method: KeypadMethod.status, reply: result)
        }
        return status
    }

    /// Sets per-key lights with `v.oai.thstatus`.
    ///
    /// Lighting changes are previews: the keypad does not save them.
    ///
    /// - Parameter lights: The lights to set; other keys keep their lights.
    /// - Throws: The errors of ``call(_:params:timeout:)``.
    public func setKeyLights(_ lights: [KeyLight]) async throws {
        guard !lights.isEmpty else { return }
        try await call(KeypadMethod.keyLights, params: KeyLight.firmwareParams(lights))
    }

    /// Sets the key backlight and the ambient ring with `v.oai.rgbcfg`.
    ///
    /// Lighting changes are previews: the keypad does not save them.
    ///
    /// - Parameter zones: The zones; an unset zone goes out as ``ZoneLight/off``.
    /// - Throws: The errors of ``call(_:params:timeout:)``.
    public func setZones(_ zones: ZoneLights) async throws {
        try await call(KeypadMethod.zones, params: zones.firmwareParams)
    }

    // MARK: - Events

    private func handle(_ event: KeypadTransportEvent) {
        switch event {
        case .connected(let device):
            reassembler.reset()
            self.device = device
            broadcast(.connected(device))
        case .disconnected:
            guard device != nil else { return }
            device = nil
            reassembler.reset()
            failAll { .disconnected(method: $0) }
            broadcast(.disconnected)
        case .report(let bytes):
            guard let frame = Report.Frame(report: bytes), frame.channel == .rpc else { return }
            for message in reassembler.append(frame.payload) {
                guard let message = RPCMessage(bytes: message) else { continue }
                receive(message)
            }
        }
    }

    private func receive(_ message: RPCMessage) {
        switch message {
        case .reply(let id, let result, let error):
            guard let entry = pending[id] else {
                broadcast(.foreignReply(id: id))
                return
            }
            if let error, error != .null {
                finish(id, with: .failure(KeypadError.remote(method: entry.method, error: error)))
            } else {
                finish(id, with: .success(result ?? .null))
            }
        case .notification(let method, let params):
            if let input = KeypadInput(method: method, params: params) {
                broadcast(.input(input))
            } else {
                broadcast(.notification(method: method, params: params))
            }
        }
    }

    private func finish(_ id: Int, with result: Result<JSONValue, any Error>) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        entry.timeout?.cancel()
        entry.continuation.resume(with: result)
    }

    private func failAll(_ error: (String) -> KeypadError) {
        let entries = pending
        pending.removeAll()
        for entry in entries.values {
            entry.timeout?.cancel()
            entry.continuation.resume(throwing: error(entry.method))
        }
    }

    private func broadcast(_ event: KeypadEvent) {
        for (id, continuation) in subscribers {
            guard case .dropped = continuation.yield(event) else { continue }
            subscribers.removeValue(forKey: id)
            continuation.finish(throwing: KeypadError.eventsOverflowed)
        }
    }

    private func removeSubscriber(_ id: UUID) {
        subscribers.removeValue(forKey: id)
    }
}
