import AppKit
import ApplicationServices
import CoreGraphics

/// The side effects that the bridge's `openURL`, `sendShortcut`, and `scroll` commands need.
///
/// The app uses ``SystemInterfaceDriver``; tests use a driver that records calls.
public protocol InterfaceDriver: Sendable {
    /// Whether the app may post keyboard events: the Accessibility permission.
    func isAccessibilityTrusted() async -> Bool

    /// Opens a URL with the app that handles its scheme.
    ///
    /// - Parameter url: The URL, already checked by ``PaseoLink``.
    /// - Throws: ``InterfaceError/openFailed(_:)`` if no app opens it.
    func open(_ url: URL) async throws

    /// Asks a running app to come to the front.
    ///
    /// The app may come to the front after this method returns;
    /// callers check ``frontmostBundleIdentifier()`` to learn when it has.
    ///
    /// - Parameter bundleIdentifier: The app's bundle identifier.
    /// - Throws: ``InterfaceError/appNotRunning(_:)`` if no running app has the identifier,
    ///   or ``InterfaceError/activationFailed(_:)`` if the system refuses the request.
    func activate(bundleIdentifier: String) async throws

    /// Returns the bundle identifier of the frontmost app.
    ///
    /// - Returns: The identifier, or `nil` if no app is frontmost or it has none.
    func frontmostBundleIdentifier() async -> String?

    /// Posts a key combination to the frontmost app.
    ///
    /// - Parameter shortcut: The key combination.
    /// - Throws: ``InterfaceError/eventFailed`` if the system cannot create the events.
    func post(_ shortcut: Shortcut) async throws

    /// Finds the frontmost on-screen window of a running app.
    ///
    /// - Parameter bundleIdentifier: The app's bundle identifier.
    /// - Returns: The app's frontmost window at the normal window level.
    /// - Throws: ``InterfaceError/appNotRunning(_:)`` if no running app has the identifier,
    ///   or ``InterfaceError/noWindow(_:)`` if the app has no such window on screen.
    func frontWindow(bundleIdentifier: String) async throws -> AppWindow

    /// Moves the pointer to a point without posting mouse-moved events.
    ///
    /// A scroll moves the pointer into the window before its events and back after them,
    /// because Paseo's window ignores scroll events posted to its process.
    ///
    /// - Parameter point: The new location, in global display coordinates.
    /// - Returns: The pointer's location before the move.
    func movePointer(to point: CGPoint) async -> CGPoint

    /// Posts one line-unit scroll-wheel event to a window's app, located at a point in the window.
    ///
    /// The event carries at most ``ScrollRequest/maximumLines`` lines in either direction,
    /// whatever `lines` is (see ``ScrollRequest/wheelDelta(lines:)``).
    /// The caller moves the pointer to the point first, with ``movePointer(to:)``.
    ///
    /// - Parameters:
    ///   - lines: The lines to scroll: positive down, negative up.
    ///   - point: Where the event happens, in global display coordinates, inside the window.
    ///   - window: The window, from ``frontWindow(bundleIdentifier:)``.
    /// - Throws: ``InterfaceError/eventFailed`` if the system cannot create the event.
    func postScroll(lines: Int, at point: CGPoint, in window: AppWindow) async throws
}

/// Errors from the interface commands.
public enum InterfaceError: Error, Sendable, Hashable, CustomStringConvertible {
    /// The URL is not a `paseo://` link.
    case notPaseoURL(String)
    /// The system could not open the URL.
    case openFailed(String)
    /// No running app has the bundle identifier.
    case appNotRunning(String)
    /// The app with the bundle identifier did not come to the front in time.
    case activationFailed(String)
    /// The app with the bundle identifier is not the frontmost app.
    case notFrontmost(String)
    /// `sendShortcut` has `activate` but no bundle identifier, or `scroll` has no bundle identifier.
    case missingBundleIdentifier
    /// The app lacks the Accessibility permission, which posting events needs.
    case accessibilityNotGranted
    /// The system could not create keyboard or scroll events.
    case eventFailed
    /// The app with the bundle identifier has no window on screen to scroll.
    case noWindow(String)
    /// A scroll's line count is zero or too large.
    case invalidScrollLines(Int)
    /// A scroll's position is not between the top and the bottom of the window.
    case invalidScrollPosition(Double)

    public var description: String {
        switch self {
        case .notPaseoURL(let url): "Only paseo:// links may be opened, not \"\(url)\""
        case .openFailed(let url): "The system could not open \(url)"
        case .appNotRunning(let id): "No running app has the bundle ID \(id)"
        case .activationFailed(let id): "\(id) did not come to the front, so the shortcut was not sent"
        case .notFrontmost(let id): "\(id) is not the frontmost app, so the shortcut was not sent"
        case .missingBundleIdentifier: "sendShortcut with activate, and scroll, need a bundleID"
        case .accessibilityNotGranted:
            "Paseo Micro needs the Accessibility permission to send shortcuts and scroll. "
                + "Turn on Paseo Micro in System Settings > Privacy & Security > Accessibility."
        case .eventFailed: "The system could not create the events"
        case .noWindow(let id): "\(id) has no window on screen to scroll"
        case .invalidScrollLines(let lines):
            "Cannot scroll \(lines) lines; use a whole number from 1 to \(ScrollRequest.maximumLines), or its negative"
        case .invalidScrollPosition(let fromTop):
            "Cannot scroll at \(fromTop) of the window's height; use a fraction greater than 0 and less than 1"
        }
    }
}

/// Validates links for the bridge's `openURL` command.
public enum PaseoLink {
    /// The only scheme that `openURL` opens.
    public static let scheme = "paseo"

    /// Parses and checks a link.
    ///
    /// - Parameter text: The link, such as `paseo://h/srv_1/agent/0b95b862`.
    /// - Returns: The URL.
    /// - Throws: ``InterfaceError/notPaseoURL(_:)`` if the text is not a URL with the `paseo` scheme
    ///   and something after it.
    public static func validate(_ text: String) throws -> URL {
        guard let components = URLComponents(string: text),
            components.scheme?.lowercased() == scheme,
            !(components.host ?? "").isEmpty || !components.path.isEmpty,
            let url = components.url
        else { throw InterfaceError.notPaseoURL(text) }
        return url
    }
}

/// The interface driver that uses `NSWorkspace` and `CGEvent`.
public struct SystemInterfaceDriver: InterfaceDriver {
    /// Creates the driver.
    public init() {}

    public func isAccessibilityTrusted() async -> Bool {
        AXIsProcessTrusted()
    }

    /// Asks the system to show its Accessibility prompt for this app.
    @MainActor
    public static func requestAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    /// Opens the Accessibility pane of System Settings.
    @MainActor
    public static func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    @MainActor
    public func open(_ url: URL) async throws {
        guard NSWorkspace.shared.open(url) else { throw InterfaceError.openFailed(url.absoluteString) }
    }

    @MainActor
    public func activate(bundleIdentifier: String) async throws {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first else {
            throw InterfaceError.appNotRunning(bundleIdentifier)
        }
        guard app.activate() else { throw InterfaceError.activationFailed(bundleIdentifier) }
    }

    @MainActor
    public func frontmostBundleIdentifier() async -> String? {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    }

    // Posts at the HID event tap, which delivers to the frontmost app;
    // the bridge checks the frontmost app immediately before it calls this method.
    public func post(_ shortcut: Shortcut) async throws {
        let source = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: shortcut.keyCode, keyDown: true),
            let up = CGEvent(keyboardEventSource: source, virtualKey: shortcut.keyCode, keyDown: false)
        else { throw InterfaceError.eventFailed }
        down.flags = shortcut.flags
        up.flags = shortcut.flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    @MainActor
    public func frontWindow(bundleIdentifier: String) async throws -> AppWindow {
        try Self.frontWindow(bundleIdentifier: bundleIdentifier)
    }

    /// Finds the frontmost on-screen window of a running app, at once.
    ///
    /// - Parameter bundleIdentifier: The app's bundle identifier.
    /// - Returns: The app's frontmost window at the normal window level.
    /// - Throws: ``InterfaceError/appNotRunning(_:)`` if no running app has the identifier,
    ///   or ``InterfaceError/noWindow(_:)`` if the app has no such window on screen.
    @MainActor
    public static func frontWindow(bundleIdentifier: String) throws -> AppWindow {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first else {
            throw InterfaceError.appNotRunning(bundleIdentifier)
        }
        // Window bounds and owners need no Screen Recording permission; only window titles do.
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
        guard let window = AppWindow.frontmost(in: list, processID: app.processIdentifier) else {
            throw InterfaceError.noWindow(bundleIdentifier)
        }
        return window
    }

    // Paseo's window ignores scroll events posted to its process (checked 2026-10-28),
    // so the sender moves the pointer to the point, posts the scrolls there,
    // and puts the pointer back. Moving the pointer this way sends no mouse-moved events.
    public func movePointer(to point: CGPoint) async -> CGPoint {
        let saved = CGEvent(source: nil)?.location ?? point
        CGWarpMouseCursorPosition(point)
        return saved
    }

    public func postScroll(lines: Int, at point: CGPoint, in window: AppWindow) async throws {
        let source = CGEventSource(stateID: .hidSystemState)
        guard
            let event = CGEvent(
                scrollWheelEvent2Source: source,
                units: .line,
                wheelCount: 1,
                wheel1: ScrollRequest.wheelDelta(lines: lines),
                wheel2: 0,
                wheel3: 0
            )
        else { throw InterfaceError.eventFailed }
        event.location = point
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
        event.setIntegerValueField(
            .mouseEventWindowUnderMousePointerThatCanHandleThisEvent,
            value: Int64(window.windowNumber)
        )
        event.post(tap: .cghidEventTap)
    }
}
