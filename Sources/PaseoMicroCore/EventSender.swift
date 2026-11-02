/// Sends the bridge's `sendShortcut` and `scroll` commands, one at a time across all clients.
///
/// Activating an app, waiting for it to come to the front, and posting the events
/// form one operation, so that two clients cannot interleave their steps
/// and send a shortcut or a scroll to the other's app.
/// With a bundle identifier, a shortcut goes out only if that app is frontmost
/// immediately before the post.
/// A scroll goes to its app's frontmost window, found immediately before the first event.
/// Its events, each of at most ``ScrollRequest/maximumLines`` lines,
/// go out ``ScrollRequest/burstInterval`` apart with the pointer in the window,
/// and the pointer goes back when they end or the scroll is canceled.
final class EventSender: Sendable {
    /// How long the pointer stays in the window before the first scroll event and after the last.
    static let pointerSettle: Duration = .milliseconds(20)

    private let interface: any InterfaceDriver
    private let activationTimeout: Duration
    private let pollInterval: Duration
    private let scrollInterval: Duration
    private let queue = SerialQueue()

    /// Creates a sender.
    ///
    /// - Parameters:
    ///   - interface: The driver that activates apps and posts events.
    ///   - activationTimeout: How long an app may take to come to the front.
    ///   - pollInterval: How often to check the frontmost app while waiting.
    ///   - scrollInterval: The time between the events of a scroll.
    init(
        interface: any InterfaceDriver,
        activationTimeout: Duration = .seconds(1),
        pollInterval: Duration = .milliseconds(25),
        scrollInterval: Duration = ScrollRequest.burstInterval
    ) {
        self.interface = interface
        self.activationTimeout = activationTimeout
        self.pollInterval = pollInterval
        self.scrollInterval = scrollInterval
    }

    /// Sends a shortcut, after every shortcut and scroll that arrived before it.
    ///
    /// - Parameters:
    ///   - shortcut: The key combination.
    ///   - bundleID: The app that must receive it, or `nil` for the frontmost app.
    ///   - activate: Whether to bring the app to the front first.
    /// - Throws: An ``InterfaceError`` if the shortcut was not sent,
    ///   or `CancellationError` if the task was canceled before the shortcut went out;
    ///   a canceled shortcut neither activates its app nor posts.
    func send(_ shortcut: Shortcut, bundleID: String?, activate: Bool) async throws {
        if activate && bundleID == nil { throw InterfaceError.missingBundleIdentifier }
        guard await interface.isAccessibilityTrusted() else { throw InterfaceError.accessibilityNotGranted }
        try await queue.run {
            if let bundleID {
                if activate { try await self.activate(bundleID) }
                guard await self.interface.frontmostBundleIdentifier() == bundleID else {
                    throw InterfaceError.notFrontmost(bundleID)
                }
            }
            // The bridge may have closed while the app came to the front.
            try Task.checkCancellation()
            try await self.interface.post(shortcut)
        }
    }

    /// Scrolls an app's frontmost window, after every shortcut and scroll that arrived before it.
    ///
    /// - Parameters:
    ///   - scroll: The lines and the point's height in the window.
    ///   - bundleID: The app to scroll.
    ///   - activate: Whether to bring the app to the front first.
    /// - Throws: An ``InterfaceError`` if the scroll was not sent,
    ///   or `CancellationError` if the task was canceled before the scroll's last event went out;
    ///   a scroll canceled before it starts neither activates its app nor posts,
    ///   and one canceled during its events posts no more of them.
    func scroll(_ scroll: ScrollRequest, bundleID: String, activate: Bool) async throws {
        guard !bundleID.isEmpty else { throw InterfaceError.missingBundleIdentifier }
        guard await interface.isAccessibilityTrusted() else { throw InterfaceError.accessibilityNotGranted }
        try await queue.run {
            if activate { try await self.activate(bundleID) }
            let window = try await self.interface.frontWindow(bundleIdentifier: bundleID)
            // The bridge may have closed while the app came to the front.
            try Task.checkCancellation()
            try await self.post(scroll, in: window)
        }
    }

    /// Posts a scroll's events with the pointer in the window, and puts the pointer back.
    private func post(_ scroll: ScrollRequest, in window: AppWindow) async throws {
        let point = scroll.point(in: window.bounds)
        let saved = await interface.movePointer(to: point)
        do {
            try await Task.sleep(for: Self.pointerSettle)
            for (index, lines) in scroll.events.enumerated() {
                if index > 0 { try await Task.sleep(for: scrollInterval) }
                try Task.checkCancellation()
                try await interface.postScroll(lines: lines, at: point, in: window)
            }
            // Every event went out; give the last one time to arrive before the pointer leaves.
            try? await Task.sleep(for: Self.pointerSettle)
        } catch {
            _ = await interface.movePointer(to: saved)
            throw error
        }
        _ = await interface.movePointer(to: saved)
    }

    /// Activates an app and waits until it is frontmost.
    private func activate(_ bundleID: String) async throws {
        try await interface.activate(bundleIdentifier: bundleID)
        let deadline = ContinuousClock.now + activationTimeout
        while await interface.frontmostBundleIdentifier() != bundleID {
            guard ContinuousClock.now < deadline else { throw InterfaceError.activationFailed(bundleID) }
            try await Task.sleep(for: pollInterval)
        }
    }
}
