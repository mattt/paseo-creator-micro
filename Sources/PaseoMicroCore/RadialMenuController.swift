import CreatorMicro
import Foundation
import Synchronization

/// What the app draws while the radial menu is open.
public struct RadialMenuPresentation: Sendable, Hashable {
    /// The menu's definition.
    public var menu: RadialMenu
    /// The slot nearest the stick, or `nil` before the stick has a direction.
    public var highlighted: Int?
    /// Whether a release now would pick the highlighted slot.
    public var isArmed: Bool

    /// Creates a presentation.
    ///
    /// - Parameters:
    ///   - menu: The menu's definition.
    ///   - highlighted: The slot nearest the stick, or `nil`.
    ///   - isArmed: Whether a release now would pick the highlighted slot.
    public init(menu: RadialMenu, highlighted: Int?, isArmed: Bool) {
        self.menu = menu
        self.highlighted = highlighted
        self.isArmed = isArmed
    }
}

/// Keeps the bridge's radial menu: its definition, the client that set it, and the selection.
///
/// The latest client to set a menu owns it, and only that client's joystick positions
/// drive it, so that each position counts once however many clients are connected.
/// The menu opens only while the keypad is on an input layer and a definition is set;
/// leaving the input layers, clearing the definition, or the owner's disconnection closes it.
/// A pick of a slot that is not enabled counts as a cancel.
/// ``cancel()``, which the app calls for Escape, and a key press or dial click on the keypad
/// while the menu is open (``intercept(_:client:)``) close it without a pick,
/// and the stick's later return to the center picks nothing.
///
/// ``presentations`` reports what to draw, `nil` while the menu is closed;
/// it keeps only the newest value for a slow reader.
public final class RadialMenuController: Sendable {
    /// What to draw, in order: a presentation while the menu is open, `nil` when it closes.
    ///
    /// Read it from one task only.
    public let presentations: AsyncStream<RadialMenuPresentation?>

    private struct State {
        var menu: RadialMenu?
        var owner: UUID?
        var onInputLayer = false
        var selector: RadialSelector
        var shown: RadialMenuPresentation?
        /// The keypad presses that cancelled the menu, whose releases the owner must not receive either.
        var swallowed: Set<KeypadInput> = []
    }

    private let state: Mutex<State>
    private let sink: AsyncStream<RadialMenuPresentation?>.Continuation
    private let now: @Sendable () -> ContinuousClock.Instant

    /// Creates a controller with no menu.
    ///
    /// - Parameters:
    ///   - tuning: The selector's distances and release window.
    ///   - now: The clock that stamps each joystick position; tests pass their own.
    public init(
        tuning: RadialSelector.Tuning = .standard,
        now: @escaping @Sendable () -> ContinuousClock.Instant = { ContinuousClock.now }
    ) {
        state = Mutex(State(selector: RadialSelector(tuning: tuning)))
        (presentations, sink) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.now = now
    }

    /// The menu's definition, or `nil` when no client has set one.
    public var menu: RadialMenu? { state.withLock { $0.menu } }

    /// What the app draws now, or `nil` while the menu is closed.
    public var presentation: RadialMenuPresentation? { state.withLock { $0.shown } }

    /// Sets the menu for a client, which then owns it.
    ///
    /// An open menu stays open and shows the new definition.
    ///
    /// - Parameters:
    ///   - menu: The definition.
    ///   - client: The client that set it.
    /// - Throws: A ``RadialMenuError`` if the definition is not valid; the menu stays as it was.
    public func set(_ menu: RadialMenu, client: UUID) throws {
        try menu.validate()
        change { state in
            if state.owner != client {
                state.selector.reset()
                state.swallowed = []
            }
            state.menu = menu
            state.owner = client
        }
    }

    /// Clears the menu if a client owns it, and closes it if it is open.
    ///
    /// - Parameter client: The client that clears it or disconnected.
    public func clear(client: UUID) {
        change { state in
            guard state.owner == client else { return }
            state.menu = nil
            state.owner = nil
            state.selector.reset()
        }
    }

    /// Follows the keypad's layer: the menu opens only on an input layer.
    ///
    /// - Parameter keypad: The keypad's state.
    public func keypadChanged(_ keypad: KeypadState) {
        change { state in
            state.onInputLayer = keypad.lightsVisible
            if !state.onInputLayer { state.selector.reset() }
        }
    }

    /// Reads a joystick position that reached a client.
    ///
    /// - Parameters:
    ///   - joystick: The position.
    ///   - client: The client that received it; positions of other clients than the owner are ignored.
    /// - Returns: The slot to report to the client, when the position picked an enabled slot.
    public func handle(_ joystick: JoystickInput, client: UUID) -> Int? {
        let time = now()
        return change { state -> Int? in
            guard state.owner == client, let menu = state.menu, state.onInputLayer else { return nil }
            guard case .picked(let slot) = state.selector.update(joystick, at: time) else { return nil }
            return menu.slots.indices.contains(slot) && menu.slots[slot].enabled ? slot : nil
        }
    }

    /// Closes the open menu without a pick, as Escape does.
    ///
    /// The stick's return to the center afterward picks nothing and does not open the menu again.
    ///
    /// - Returns: Whether the menu was open.
    @discardableResult
    public func cancel() -> Bool {
        change { $0.selector.dismiss() }
    }

    /// Decides whether a keypad input that reached the menu's owner cancels the open menu.
    ///
    /// A press of one of the keypad's keys (0–12) or of the dial while the menu is open
    /// cancels it, as ``cancel()`` does, and the owner receives neither that press nor its release,
    /// so that the press does only the cancel.
    /// Keys 13–19 do not cancel, because a keymap can bind the joystick's sectors to them,
    /// and a push that opens the menu sends them.
    ///
    /// - Parameters:
    ///   - input: The input.
    ///   - client: The client that received it; inputs of other clients than the owner pass.
    /// - Returns: Whether to keep the input from the client.
    public func intercept(_ input: KeypadInput, client: UUID) -> Bool {
        change { state -> Bool in
            guard state.owner == client else { return false }
            let press: KeypadInput
            switch input {
            case .key(let key) where key.key <= 12:
                press = .key(KeyInput(key: key.key, action: .press))
                guard key.action == .press else { return state.swallowed.remove(press) != nil }
            case .dial(.press):
                press = .dial(.press)
            case .dial(.release):
                return state.swallowed.remove(.dial(.press)) != nil
            default:
                return false
            }
            guard state.selector.dismiss() else { return false }
            state.swallowed.insert(press)
            return true
        }
    }

    /// Ends ``presentations``.
    public func finish() {
        sink.finish()
    }

    /// Changes the state and reports a new presentation, in order, if it changed.
    private func change<Result>(_ body: (inout State) -> Result) -> Result {
        state.withLock { state in
            let result = body(&state)
            let shown = state.menu.flatMap { menu in
                state.selector.isOpen
                    ? RadialMenuPresentation(
                        menu: menu,
                        highlighted: state.selector.highlighted,
                        isArmed: state.selector.isArmed
                    ) : nil
            }
            if shown != state.shown {
                state.shown = shown
                sink.yield(shown)
            }
            return result
        }
    }
}
