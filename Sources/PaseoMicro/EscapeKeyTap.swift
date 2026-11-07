import AppKit
import CoreGraphics
import PaseoMicroCore
import PaseoMicroMenu

/// Drops Escape on the Mac's keyboard while the radial menu shows, and cancels the menu instead.
///
/// The menu's panel never becomes key, so Escape would reach Paseo, where it interrupts the agent.
/// While the menu shows, and only then, the tap is an active `CGEvent` tap at the session level,
/// at the head of the other taps, for key-down and key-up events.
/// It drops each Escape keystroke that starts while the menu shows, including its key repeats
/// and its key-up (see ``EscapeKeyFilter``), and passes every other key.
/// When the menu closes, the tap goes away at once,
/// or after the dropped Escape's key-up, waiting at most ``keyUpGrace``.
/// When the system disables the tap, as after a slow callback, the tap enables itself again.
@MainActor
final class EscapeKeyTap {
    /// The longest time that the tap stays after the menu closes, for a dropped Escape's key-up.
    static let keyUpGrace: Duration = .seconds(1)

    private let onEscape: @MainActor () -> Void
    private let onProblem: @MainActor (EscapeTapProblem?) -> Void
    private var port: CFMachPort?
    private var source: CFRunLoopSource?
    private var filter = EscapeKeyFilter()
    private var menuOpen = false
    private var removal: Task<Void, Never>?

    /// Creates a tap that is not installed.
    ///
    /// - Parameters:
    ///   - onEscape: Called when Escape is pressed while the menu shows.
    ///   - onProblem: Called with the reason after the tap fails to install, and with `nil` after it installs.
    init(
        onEscape: @escaping @MainActor () -> Void,
        onProblem: @escaping @MainActor (EscapeTapProblem?) -> Void
    ) {
        self.onEscape = onEscape
        self.onProblem = onProblem
    }

    /// Installs the tap when the menu opens and removes it when the menu closes.
    ///
    /// - Parameter open: Whether the menu shows now.
    func menuChanged(open: Bool) {
        menuOpen = open
        if open {
            removal?.cancel()
            removal = nil
            install()
        } else if filter.awaitingKeyUp {
            scheduleRemoval(after: Self.keyUpGrace)
        } else {
            remove()
        }
    }

    private func install() {
        guard port == nil else { return }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue) | CGEventMask(1 << CGEventType.keyUp.rawValue)
        guard
            let port = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .defaultTap,
                eventsOfInterest: mask,
                callback: escapeTapCallback,
                userInfo: Unmanaged.passUnretained(self).toOpaque()
            ),
            let source = CFMachPortCreateRunLoopSource(nil, port, 0)
        else {
            onProblem(Self.diagnose())
            return
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        self.port = port
        self.source = source
        onProblem(nil)
    }

    private func remove() {
        removal?.cancel()
        removal = nil
        filter.reset()
        guard let port else { return }
        CGEvent.tapEnable(tap: port, enable: false)
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        CFMachPortInvalidate(port)
        self.port = nil
        source = nil
    }

    /// Removes the tap later, outside the tap's callback.
    private func scheduleRemoval(after delay: Duration) {
        removal?.cancel()
        removal = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled, let self, !self.menuOpen else { return }
            self.remove()
        }
    }

    /// Handles one event from the tap.
    ///
    /// - Returns: Whether to deliver the event.
    fileprivate func handle(_ type: CGEventType, keyCode: Int64) -> Bool {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let port { CGEvent.tapEnable(tap: port, enable: true) }
            return true
        case .keyDown, .keyUp:
            switch filter.decide(keyCode: keyCode, isKeyDown: type == .keyDown, menuOpen: menuOpen) {
            case .pass:
                return true
            case .drop:
                if !menuOpen && !filter.awaitingKeyUp { scheduleRemoval(after: .zero) }
                return false
            case .dropAndCancel:
                onEscape()
                return false
            }
        default:
            return true
        }
    }

    /// The permission that the tap most likely lacks.
    ///
    /// `CGEventTapCreate` returns no tap when the process may not see key events,
    /// which its header ties to the Accessibility permission;
    /// newer macOS versions may also ask for Input Monitoring.
    private static func diagnose() -> EscapeTapProblem {
        if !AXIsProcessTrusted() { return .accessibility }
        if !CGPreflightListenEventAccess() { return .inputMonitoring }
        return .refused
    }

    /// Asks for the Input Monitoring permission and opens its settings pane.
    static func requestInputMonitoring() {
        _ = CGRequestListenEventAccess()
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent") {
            NSWorkspace.shared.open(url)
        }
    }
}

/// The tap's callback, which runs on the main run loop, where the tap's source is.
private func escapeTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let tap = Unmanaged<EscapeKeyTap>.fromOpaque(userInfo).takeUnretainedValue()
    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    let deliver = MainActor.assumeIsolated { tap.handle(type, keyCode: keyCode) }
    return deliver ? Unmanaged.passUnretained(event) : nil
}
