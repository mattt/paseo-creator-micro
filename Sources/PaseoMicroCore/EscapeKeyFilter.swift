/// Decides what the app does with each Escape key event while its keyboard event tap is installed.
///
/// The radial menu's panel never becomes key, so Escape goes to Paseo,
/// where it interrupts the agent. While the menu is open, the app drops Escape
/// and cancels the menu instead. It also drops the rest of that keystroke,
/// its key repeats and its key-up, even after the menu has closed,
/// so that Paseo never sees part of it. Other keys pass.
///
/// The filter is pure state, so tests can drive it without posting events.
public struct EscapeKeyFilter: Sendable, Hashable {
    /// The virtual key code of Escape (`kVK_Escape`).
    public static let escapeKeyCode: Int64 = 53

    /// What to do with one key event.
    public enum Decision: Sendable, Hashable {
        /// Deliver the event as it is.
        case pass
        /// Drop the event.
        case drop
        /// Drop the event and cancel the radial menu.
        case dropAndCancel
    }

    /// Whether an Escape key-down was dropped and its key-up has not arrived yet.
    public private(set) var awaitingKeyUp = false

    /// Creates a filter that has dropped nothing.
    public init() {}

    /// Decides what to do with a key event.
    ///
    /// - Parameters:
    ///   - keyCode: The event's virtual key code.
    ///   - isKeyDown: Whether the event is a key-down (including a key repeat) rather than a key-up.
    ///   - menuOpen: Whether the radial menu is open now.
    /// - Returns: The decision.
    public mutating func decide(keyCode: Int64, isKeyDown: Bool, menuOpen: Bool) -> Decision {
        guard keyCode == Self.escapeKeyCode else { return .pass }
        if isKeyDown {
            if menuOpen {
                awaitingKeyUp = true
                return .dropAndCancel
            }
            return awaitingKeyUp ? .drop : .pass
        }
        guard awaitingKeyUp else { return .pass }
        awaitingKeyUp = false
        return .drop
    }

    /// Forgets a dropped key-down, as when the tap is removed before its key-up arrives.
    public mutating func reset() {
        awaitingKeyUp = false
    }
}
