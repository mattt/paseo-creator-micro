import CreatorMicro
import Foundation

/// A change that a ``KeypadSession`` reports.
public enum SessionEvent: Sendable, Hashable {
    /// The keypad's state changed.
    case state(KeypadState)
    /// The keypad sent an input.
    case input(KeypadInput)
    /// The desired lights changed.
    case lights(DesiredLights)
}

/// Errors from a ``KeypadSession``.
public enum SessionError: Error, Sendable, Hashable, CustomStringConvertible {
    /// A key index is outside 0...12.
    case invalidKey(Int)
    /// Events arrived faster than a stream's reader took them, so the stream ended;
    /// subscribe again and read the session's state.
    case eventsLost

    public var description: String {
        switch self {
        case .invalidKey(let key): "Key \(key) does not exist; keys run from 0 to \(KeyInput.count - 1)"
        case .eventsLost: "The keypad's events arrived faster than they were read, and some were lost"
        }
    }
}

/// Keeps the keypad session alive and holds the lights that the app wants.
///
/// The session connects through its transport and follows reconnections,
/// polls `device.status` for the layer and battery,
/// reads the keypad's keymap (read-only) to learn which layers are input layers
/// and which layer is the ChatGPT layer (see ``InputLayers``),
/// and sends the desired lights again after a reconnect
/// and when the keypad returns to an input layer.
///
/// Every lighting write goes through one ordered queue,
/// and each write sends the desired lights as they are when it runs,
/// so that a slow write never replaces newer lights with older ones.
/// The session also tracks the keys and zones that changed
/// and that the keypad has not yet confirmed, such as the lights that a clear turned off,
/// and sends them with the next write until the keypad confirms them.
///
/// While the ChatGPT app runs (see ``setChatGPTRunning(_:)``),
/// the session pauses its lighting writes on the ChatGPT layer, which Codex drives,
/// and keeps the desired lights (see ``KeypadState/lightsPaused``).
/// On the other input layers, it keeps writing its lights
/// and paints every light again every ``chatGPTRepaintInterval``,
/// because Codex resets per-key lights within about two minutes.
public actor KeypadSession {
    /// How long a read of the keypad's keymap may take; the file is a few kilobytes.
    public static let keymapReadTimeout: Duration = .seconds(10)

    /// How often the session paints every light again while the ChatGPT app runs
    /// and the keypad is on an input layer other than the ChatGPT layer.
    public static let chatGPTRepaintInterval: Duration = .seconds(30)

    /// The JSON-RPC client for the keypad.
    public nonisolated let client: KeypadClient

    /// What the session knows about the keypad.
    public private(set) var state = KeypadState.disconnected

    /// The lights that the app wants on the keypad.
    public private(set) var lights = DesiredLights()

    /// The most recent input, if any.
    public private(set) var lastInput: KeypadInput?

    /// Whether the ChatGPT app runs and can reach the keypad, from ``setChatGPTRunning(_:)``.
    public private(set) var chatGPTRunning = false

    /// Whether the session holds its lighting writes now: see ``KeypadState/lightsPaused``.
    public var lightsPaused: Bool { state.lightsPaused }

    private let pollInterval: Duration
    private let repaintInterval: Duration
    private let requestTimeout: Duration
    private let eventBufferLimit: Int
    private let updateBufferLimit: Int
    private let keymapRefreshInterval: Duration
    /// The input layers and their lightable keys from the last keymap read since the keypad connected,
    /// else the fallback.
    private var keymapLayers = InputLayers.fallbackLightableKeys
    /// The input layers, from ``keymapLayers``.
    private var inputLayers: Set<Int> { Set(keymapLayers.keys) }
    /// The ChatGPT layer from the last keymap read since the keypad connected, else the fallback.
    private var chatGPTLayer = InputLayers.fallbackChatGPTLayer
    /// The layers that the keypad reported since the last keymap read.
    private var seenLayers: Set<Int> = []
    /// When the session last read the keymap, to read it at most once per refresh interval;
    /// `nil` until the read that follows a connection starts.
    private var keymapReadAt: ContinuousClock.Instant?
    /// The work that follows the latest connection: see ``didConnect()``.
    private var connecting: Task<Void, Never>?
    private var tasks: [Task<Void, Never>] = []
    private var subscribers: [UUID: AsyncThrowingStream<SessionEvent, any Error>.Continuation] = [:]
    private let lighting = SerialQueue()
    /// The keys whose desired light, or off, the keypad has not confirmed.
    private var pendingKeys: Set<Int> = []
    /// Whether the keypad has not confirmed the desired zones.
    private var zonesPending = false

    /// Creates a session.
    ///
    /// - Parameters:
    ///   - transport: The transport to the keypad.
    ///   - pollInterval: How often to ask the keypad for its status.
    ///   - requestTimeout: How long to wait for each reply.
    ///   - eventBufferLimit: The most keypad events that may wait for the session.
    ///     If more wait, the session ends every stream from ``updates()`` with
    ///     ``SessionError/eventsLost``, subscribes again, and reads the keypad's state again.
    ///   - updateBufferLimit: The most changes that may wait for each reader of ``updates()``.
    ///   - keymapRefreshInterval: The shortest time between two reads of the keymap
    ///     after the keypad reports a layer that the session has not seen since its last read.
    ///   - repaintInterval: How often to paint every light again while the ChatGPT app runs
    ///     and the keypad is on an input layer other than the ChatGPT layer.
    public init(
        transport: any KeypadTransport,
        pollInterval: Duration = .seconds(2),
        requestTimeout: Duration = .seconds(3),
        eventBufferLimit: Int = 256,
        updateBufferLimit: Int = 256,
        keymapRefreshInterval: Duration = .seconds(60),
        repaintInterval: Duration = KeypadSession.chatGPTRepaintInterval
    ) {
        self.client = KeypadClient(transport: transport)
        self.pollInterval = pollInterval
        self.repaintInterval = repaintInterval
        self.requestTimeout = requestTimeout
        self.eventBufferLimit = eventBufferLimit
        self.updateBufferLimit = max(1, updateBufferLimit)
        self.keymapRefreshInterval = keymapRefreshInterval
    }

    /// Starts the session. Calling it again has no effect.
    public func start() async {
        guard tasks.isEmpty else { return }
        let events = await client.events(bufferLimit: eventBufferLimit)
        tasks.append(
            Task {
                var events = events
                while !Task.isCancelled {
                    do {
                        for try await event in events {
                            await self.waitWhileEventsHeld()
                            self.handle(event)
                        }
                        return
                    } catch {
                        events = await self.recoverLostEvents()
                    }
                }
            }
        )
        tasks.append(
            Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: self.pollInterval)
                    guard !Task.isCancelled else { break }
                    await self.poll()
                }
            }
        )
        tasks.append(
            Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: self.repaintInterval)
                    guard !Task.isCancelled else { break }
                    await self.repaintForChatGPT()
                }
            }
        )
        await client.start()
    }

    /// Stops the session and releases the keypad.
    public func stop() async {
        releaseEvents()
        for task in tasks { task.cancel() }
        tasks.removeAll()
        await client.stop()
        update(disconnectedState)
        for continuation in subscribers.values { continuation.finish() }
        subscribers.removeAll()
    }

    /// Returns a stream of changes from now on.
    ///
    /// The stream never drops a change without notice.
    /// When the caller falls so far behind that its buffer fills,
    /// or when the session itself falls behind the keypad,
    /// the stream delivers the changes that it holds, then throws ``SessionError/eventsLost``.
    /// A reader that must not miss an input, such as one that tracks a held key,
    /// should treat that error as the loss of every key that it holds.
    ///
    /// - Returns: The changes, in order.
    public func updates() -> AsyncThrowingStream<SessionEvent, any Error> {
        subscribe().stream
    }

    private func subscribe() -> (id: UUID, stream: AsyncThrowingStream<SessionEvent, any Error>) {
        let (stream, continuation) = AsyncThrowingStream<SessionEvent, any Error>.makeStream(
            bufferingPolicy: .bufferingOldest(updateBufferLimit)
        )
        let id = UUID()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeSubscriber(id) }
        }
        return (id, stream)
    }

    /// Sets lights for some keys, and keeps them through reconnects.
    ///
    /// - Parameter keyLights: The lights; other keys keep their lights.
    /// - Throws: ``SessionError/invalidKey(_:)`` for a key outside 0...12,
    ///   or a ``KeypadError`` if the keypad is connected and the call fails.
    ///   When no keypad is connected, or lighting is paused,
    ///   the lights wait for the next chance.
    public func setKeyLights(_ keyLights: [KeyLight]) async throws {
        if let bad = keyLights.first(where: { !(0 ..< KeyInput.count).contains($0.key) }) {
            throw SessionError.invalidKey(bad.key)
        }
        guard !keyLights.isEmpty else { return }
        lights.set(keyLights)
        pendingKeys.formUnion(keyLights.map(\.key))
        broadcast(.lights(lights))
        try await lighting.run { try await self.sendPendingLights() }
    }

    /// Sets the key backlight and the ambient ring, and keeps them through reconnects.
    ///
    /// The firmware takes both zones in one call,
    /// so a zone that no one has set, or that a clear turned off, goes out as off.
    /// With neither zone, nothing changes and nothing is sent.
    ///
    /// - Parameters:
    ///   - keys: The key backlight, or `nil` to keep the current one.
    ///   - ambient: The ambient ring, or `nil` to keep the current one.
    /// - Throws: A ``KeypadError`` if the keypad is connected and the call fails.
    public func setZones(keys: ZoneLight?, ambient: ZoneLight?) async throws {
        guard keys != nil || ambient != nil else { return }
        if let keys { lights.zones.keys = keys }
        if let ambient { lights.zones.ambient = ambient }
        zonesPending = true
        broadcast(.lights(lights))
        try await lighting.run { try await self.sendPendingLights() }
    }

    /// Turns off every key light and both zones, and forgets the desired lights.
    ///
    /// When no keypad is connected, lighting is paused, or a call fails,
    /// the session keeps the lights off as pending and sends them at the next chance.
    ///
    /// - Throws: A ``KeypadError`` if the keypad is connected and a call fails.
    public func clearLights() async throws {
        lights = DesiredLights()
        pendingKeys = Set(0 ..< KeyInput.count)
        zonesPending = true
        broadcast(.lights(lights))
        try await lighting.run { try await self.sendPendingLights() }
    }

    /// Records whether the ChatGPT app runs, which decides when lighting pauses.
    ///
    /// While ChatGPT runs and the keypad is on the ChatGPT layer,
    /// the session keeps the desired lights, polls the keypad,
    /// and reports inputs, but it sends no lighting writes,
    /// because Codex sets the lights on that layer.
    /// On other layers, it paints every light at once and every ``chatGPTRepaintInterval``.
    /// When ChatGPT launches or quits and lighting is not paused,
    /// the session paints every light at once, to replace what Codex set.
    ///
    /// - Parameter running: Whether the ChatGPT app runs and can reach the keypad.
    public func setChatGPTRunning(_ running: Bool) async {
        guard running != chatGPTRunning else { return }
        chatGPTRunning = running
        var next = state
        next.chatGPTRunning = running
        update(next)
        if !state.lightsPaused { await applyLights(everyLight: true) }
    }

    /// Waits for the next input.
    ///
    /// - Parameter timeout: How long to wait.
    /// - Returns: The input, or `nil` if none arrived in time or the task was canceled.
    public func nextInput(timeout: Duration) async -> KeypadInput? {
        let (id, stream) = subscribe()
        // End the subscription before returning, so that a canceled wait leaves nothing behind.
        defer { removeSubscriber(id) }
        return await withTaskGroup(of: KeypadInput?.self) { group in
            group.addTask {
                do {
                    for try await event in stream {
                        if case .input(let input) = event { return input }
                    }
                } catch {
                    // Lost events end the wait without an input.
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// Asks the keypad for its status now, reads the keymap again if the keypad reports a layer
    /// that the session has not seen since its last read (at most once per refresh interval,
    /// and never before the read that follows a connection),
    /// and sends the lights again if the keypad returned to an input layer where lighting is not paused,
    /// such as when it leaves the ChatGPT layer while ChatGPT runs.
    public func poll() async {
        guard state.connected else { return }
        guard let status = try? await statusWithTimeout(), state.connected else { return }
        let wasShowingLights = state.layer == nil || showsLights
        apply(status)
        if let layer = status.layer, !seenLayers.contains(layer) {
            seenLayers.insert(layer)
            // Before the read that follows a connection starts, that read covers this layer.
            if let keymapReadAt, ContinuousClock.now - keymapReadAt >= keymapRefreshInterval {
                await readInputLayers()
            }
        }
        if !wasShowingLights, showsLights {
            await applyLights(everyLight: chatGPTRunning)
        }
    }

    /// Whether the keypad is on an input layer where the session writes its lights.
    private var showsLights: Bool { state.isOnInputLayer && !state.lightsPaused }

    /// Paints every light again if the ChatGPT app runs
    /// and the keypad is on an input layer other than the ChatGPT layer;
    /// the session calls it every ``chatGPTRepaintInterval``.
    func repaintForChatGPT() async {
        guard chatGPTRunning, state.connected, showsLights else { return }
        await applyLights(everyLight: true)
    }

    // MARK: - Private

    private func handle(_ event: KeypadEvent) {
        switch event {
        case .connected(let device):
            resetInputLayers()
            update(makeState(transport: device.transport))
            connecting = Task { await self.didConnect() }
        case .disconnected:
            update(disconnectedState)
        case .input(let input):
            lastInput = input
            broadcast(.input(input))
        case .notification, .foreignReply:
            break
        }
    }

    /// Subscribes to the client's events again after the session fell behind them,
    /// ends every stream from ``updates()``, because their readers missed events,
    /// and reads the keypad's state again.
    ///
    /// - Returns: The new stream of the client's events.
    private func recoverLostEvents() async -> AsyncThrowingStream<KeypadEvent, any Error> {
        let events = await client.events(bufferLimit: eventBufferLimit)
        let subscribers = subscribers
        self.subscribers.removeAll()
        for continuation in subscribers.values { continuation.finish(throwing: SessionError.eventsLost) }
        if let device = await client.device {
            if !state.connected {
                update(makeState(transport: device.transport))
            }
            connecting = Task { await self.didConnect() }
        } else {
            update(disconnectedState)
        }
        return events
    }

    private func didConnect() async {
        guard state.connected else { return }
        if let version = try? await client.call(KeypadMethod.version, timeout: requestTimeout)["version"]?.stringValue,
            state.connected
        {
            var next = state
            next.firmware = version
            update(next)
        }
        await readInputLayers()
        if let status = try? await statusWithTimeout(), state.connected {
            apply(status)
            if let layer = status.layer { seenLayers.insert(layer) }
        }
        await applyLights(everyLight: chatGPTRunning)
    }

    /// Forgets what the session learned from the keymap, as when another keypad connects.
    private func resetInputLayers() {
        keymapLayers = InputLayers.fallbackLightableKeys
        chatGPTLayer = InputLayers.fallbackChatGPTLayer
        seenLayers = []
        keymapReadAt = nil
    }

    /// Reads the keymap and updates the input layers and the ChatGPT layer.
    ///
    /// A failed read keeps the layers from the last read since the keypad connected,
    /// else ``InputLayers/fallback`` and ``InputLayers/fallbackChatGPTLayer``.
    private func readInputLayers() async {
        guard state.connected else { return }
        keymapReadAt = .now
        seenLayers = state.layer.map { [$0] } ?? []
        guard
            let reply = try? await client.call(
                KeypadMethod.readFile,
                params: ["file": .string(InputLayers.keymapFile)],
                timeout: Self.keymapReadTimeout
            ),
            let keymap = InputLayers.keymap(readReply: reply),
            let layers = InputLayers.lightableKeys(keymap: keymap),
            state.connected
        else { return }
        keymapLayers = layers
        chatGPTLayer = InputLayers.chatGPTLayer(keymap: keymap) ?? InputLayers.fallbackChatGPTLayer
        update(
            makeState(
                transport: state.transport,
                firmware: state.firmware,
                layer: state.layer,
                battery: state.battery,
                charging: state.charging
            )
        )
    }

    private func statusWithTimeout() async throws -> KeypadStatus {
        let result = try await client.call(KeypadMethod.status, timeout: requestTimeout)
        guard let status = KeypadStatus(result: result) else {
            throw KeypadError.unexpectedReply(method: KeypadMethod.status, reply: result)
        }
        return status
    }

    private func apply(_ status: KeypadStatus) {
        update(
            makeState(
                transport: state.transport,
                firmware: status.version ?? state.firmware,
                layer: status.layer,
                battery: status.battery,
                charging: status.isCharging
            )
        )
    }

    /// The state of a connected keypad, with what the session learned from the keymap and about ChatGPT.
    private func makeState(
        transport: String?,
        firmware: String? = nil,
        layer: Int? = nil,
        battery: Int? = nil,
        charging: Bool? = nil
    ) -> KeypadState {
        KeypadState(
            connected: true,
            transport: transport,
            firmware: firmware,
            layer: layer,
            battery: battery,
            charging: charging,
            inputLayers: inputLayers,
            lightableKeys: keymapLayers,
            chatGPTLayer: chatGPTLayer,
            chatGPTRunning: chatGPTRunning
        )
    }

    /// The state with no keypad connected, which keeps whether ChatGPT runs.
    private var disconnectedState: KeypadState {
        KeypadState(connected: false, chatGPTRunning: chatGPTRunning)
    }

    /// Whether lighting writes may go to the keypad now.
    private var canWriteLights: Bool { state.connected && !state.lightsPaused }

    /// The light that a key should show: its desired light, or off.
    private func target(forKey key: Int) -> KeyLight {
        lights.light(forKey: key) ?? .off(key: key)
    }

    /// Sends the lights of some keys, as they are now, and marks the ones that the keypad confirmed.
    ///
    /// A key whose light changed while the call waited stays pending.
    ///
    /// - Note: Call only from the lighting queue.
    private func sendKeyLights(_ keys: Set<Int>) async throws {
        guard canWriteLights, !keys.isEmpty else { return }
        let entries = keys.sorted().map(target(forKey:))
        try await client.call(KeypadMethod.keyLights, params: KeyLight.firmwareParams(entries), timeout: requestTimeout)
        for entry in entries where target(forKey: entry.key) == entry {
            pendingKeys.remove(entry.key)
        }
    }

    /// Sends both desired zones, as they are now, and marks them confirmed if they did not change meanwhile.
    ///
    /// - Note: Call only from the lighting queue.
    private func sendZones() async throws {
        guard canWriteLights else { return }
        let zones = lights.zones
        try await client.call(KeypadMethod.zones, params: zones.firmwareParams, timeout: requestTimeout)
        if lights.zones == zones { zonesPending = false }
    }

    /// Sends the keys and zones that the keypad has not confirmed.
    ///
    /// - Note: Call only from the lighting queue.
    private func sendPendingLights() async throws {
        try await sendKeyLights(pendingKeys)
        if zonesPending { try await sendZones() }
    }

    /// Sends every desired light through the lighting queue; failures wait for the next chance.
    ///
    /// - Parameter everyLight: Whether to send every key, off where no light is desired, and both zones,
    ///   to replace lights that another program, such as Codex, set.
    private func applyLights(everyLight: Bool = false) async {
        try? await lighting.run { await self.replayLights(everyLight: everyLight) }
    }

    /// Sends every desired light and every pending change, as they are when each call goes out.
    ///
    /// - Parameter everyLight: Whether to send every key and both zones as well.
    /// - Note: Call only from the lighting queue.
    private func replayLights(everyLight: Bool) async {
        let keys = everyLight ? Set(0 ..< KeyInput.count) : pendingKeys.union(lights.keys.keys)
        try? await sendKeyLights(keys)
        if everyLight || zonesPending || !lights.zones.isEmpty {
            try? await sendZones()
        }
    }

    private func update(_ newState: KeypadState) {
        guard newState != state else { return }
        state = newState
        broadcast(.state(newState))
    }

    private func broadcast(_ event: SessionEvent) {
        for (id, continuation) in subscribers {
            guard case .dropped = continuation.yield(event) else { continue }
            subscribers.removeValue(forKey: id)
            continuation.finish(throwing: SessionError.eventsLost)
        }
    }

    // MARK: - Testing

    /// Waits until the work that follows the latest connection finishes:
    /// the version, the keymap read, the status, and the lights, for tests.
    func waitForConnection() async {
        await connecting?.value
    }

    /// The number of streams from ``updates()`` that are open, for tests.
    var subscriberCount: Int { subscribers.count }

    private var eventsHeld = false
    private var eventWaiters: [CheckedContinuation<Void, Never>] = []

    /// Stops handling the client's events until ``releaseEvents()``,
    /// so that tests can make the session fall behind the keypad.
    func holdEvents() {
        eventsHeld = true
    }

    /// Handles the client's events again.
    func releaseEvents() {
        eventsHeld = false
        let waiters = eventWaiters
        eventWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    private func waitWhileEventsHeld() async {
        guard eventsHeld else { return }
        await withCheckedContinuation { eventWaiters.append($0) }
    }

    private func removeSubscriber(_ id: UUID) {
        subscribers.removeValue(forKey: id)?.finish()
    }
}
