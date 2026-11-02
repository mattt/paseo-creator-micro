import CreatorMicro

/// Turns joystick positions into a radial menu's open, highlight, pick, and cancel.
///
/// The selector is a pure state machine: it reads each position with the time it arrived
/// and keeps no clock or timer of its own.
///
/// - The menu opens when the stick, away from rest, reaches ``Tuning/openDistance``.
/// - While it is open, the highlighted slot is the one nearest the stick's angle,
///   among eight 45° sectors centered on the directions (``slot(forAngle:)``).
///   The highlight follows the stick only at ``Tuning/openDistance`` or farther,
///   so that the noisy angles near the center during a release do not move it.
/// - A slot is *armed* while the stick is at ``Tuning/selectDistance`` or farther in its sector.
///   The last armed slot stays armed until the stick returns to rest or arms another slot.
/// - When the stick returns to rest (sector −1, or below ``Tuning/restDistance``),
///   the menu picks the armed slot if the stick took at most ``Tuning/releaseWindow``
///   from leaving ``Tuning/selectDistance`` to rest: a released stick springs back in a few samples.
///   A slow return through the center, or a release from below ``Tuning/selectDistance``
///   with no armed slot, cancels.
///
/// The window counts from the first position below the select distance rather than from the
/// last armed position, so a stick that is held still for a long time, which may send no positions,
/// still picks when it is released.
///
/// ``dismiss()`` closes the menu without an outcome, as Escape does,
/// and the selector ignores the stick until it returns to rest,
/// so that the stick's return neither picks nor opens the menu again.
public struct RadialSelector: Sendable, Hashable {
    /// The distances and the time that decide when the menu opens, picks, and cancels.
    ///
    /// The values are first guesses for firmware 0.6.3 and need a check at the keypad.
    /// Distances run from 0 at the center to 1 at full travel.
    public struct Tuning: Sendable, Hashable {
        /// The distance at which the menu opens and the highlight follows the stick.
        public var openDistance: Double
        /// The distance at which the highlighted slot is armed, so that a release picks it.
        public var selectDistance: Double
        /// Below this distance, as with sector −1, the stick is at rest.
        public var restDistance: Double
        /// The longest time from leaving ``selectDistance`` to rest that still counts as a release.
        public var releaseWindow: Duration

        /// Creates a tuning.
        ///
        /// - Parameters:
        ///   - openDistance: The distance at which the menu opens.
        ///   - selectDistance: The distance at which a slot is armed.
        ///   - restDistance: The distance below which the stick is at rest.
        ///   - releaseWindow: The longest return from ``selectDistance`` to rest that picks.
        public init(openDistance: Double, selectDistance: Double, restDistance: Double, releaseWindow: Duration) {
            self.openDistance = openDistance
            self.selectDistance = selectDistance
            self.restDistance = restDistance
            self.releaseWindow = releaseWindow
        }

        /// The app's tuning: open at 0.5, arm at 0.75, rest below 0.15, and a 250-millisecond release.
        ///
        /// The plugin's joystick prompts fire at 0.6 and rest below 0.1;
        /// the menu opens earlier, so that it shows before a full push,
        /// and arms later, so that a partial push can still be abandoned.
        /// A spring-back crosses from 0.75 to rest in a few samples,
        /// well inside 250 milliseconds, while a deliberate drift back takes longer.
        public static let standard = Tuning(
            openDistance: 0.5,
            selectDistance: 0.75,
            restDistance: 0.15,
            releaseWindow: .milliseconds(250)
        )
    }

    /// How an open menu ended.
    public enum Outcome: Sendable, Hashable {
        /// The stick was released from a slot; the value is the slot, 0 (up) to 7, clockwise.
        case picked(Int)
        /// The stick returned to the center slowly, or from too short a push.
        case cancelled
    }

    /// The distances and the time that the selector uses.
    public let tuning: Tuning
    /// Whether the menu is open.
    public private(set) var isOpen = false
    /// The slot nearest the stick's angle while the menu is open, or `nil` when it is closed.
    public private(set) var highlighted: Int?
    /// Whether the stick is now at ``Tuning/selectDistance`` or farther, so that a release picks.
    public private(set) var isArmed = false

    /// Whether the menu was dismissed, so that the stick must reach rest before it can open again.
    public private(set) var isDismissed = false

    private var armedSlot: Int?
    private var returnStarted: ContinuousClock.Instant?

    /// Creates a closed selector.
    ///
    /// - Parameter tuning: The distances and the time to use.
    public init(tuning: Tuning = .standard) {
        self.tuning = tuning
    }

    /// Reads one joystick position.
    ///
    /// - Parameters:
    ///   - position: The position, from `kb.radial`.
    ///   - time: When the position arrived.
    /// - Returns: How the menu ended, when this position returned the stick to rest
    ///   while the menu was open; otherwise `nil`.
    public mutating func update(_ position: JoystickInput, at time: ContinuousClock.Instant) -> Outcome? {
        let resting = position.sector < 0 || position.distance < tuning.restDistance
        if isDismissed {
            if resting { isDismissed = false }
            return nil
        }
        guard isOpen else {
            if !resting && position.distance >= tuning.openDistance {
                isOpen = true
                follow(position, at: time)
            }
            return nil
        }
        guard resting else {
            follow(position, at: time)
            return nil
        }
        defer { reset() }
        guard let armedSlot else { return .cancelled }
        if let returnStarted, time - returnStarted > tuning.releaseWindow { return .cancelled }
        return .picked(armedSlot)
    }

    /// Closes an open menu without an outcome, and ignores the stick until it returns to rest,
    /// so that the stick's return neither picks nor opens the menu again.
    ///
    /// - Returns: Whether the menu was open.
    @discardableResult
    public mutating func dismiss() -> Bool {
        guard isOpen else { return false }
        reset()
        isDismissed = true
        return true
    }

    /// Closes the menu without an outcome, as when the keypad leaves its input layers.
    public mutating func reset() {
        isDismissed = false
        isOpen = false
        highlighted = nil
        isArmed = false
        armedSlot = nil
        returnStarted = nil
    }

    private mutating func follow(_ position: JoystickInput, at time: ContinuousClock.Instant) {
        let slot = Self.slot(forAngle: position.angle)
        if position.distance >= tuning.openDistance { highlighted = slot }
        if position.distance >= tuning.selectDistance {
            armedSlot = slot
            isArmed = true
            returnStarted = nil
        } else {
            isArmed = false
            if armedSlot != nil && returnStarted == nil { returnStarted = time }
        }
    }

    /// The slot nearest a joystick angle.
    ///
    /// Each slot owns the 45° sector centered on its direction:
    /// slot 0 is up (angle 0.25), slot 2 is right (angle 0, on both sides of east),
    /// slot 4 is down (0.75), and slot 6 is left (0.5).
    ///
    /// - Parameter angle: The angle, as a fraction of a turn counterclockwise from east;
    ///   values outside 0..<1 wrap around.
    /// - Returns: The slot, from 0 (up) to 7, clockwise.
    public static func slot(forAngle angle: Double) -> Int {
        let clockwiseFromUp = 0.25 - angle
        let turn = clockwiseFromUp - clockwiseFromUp.rounded(.down)
        let slot = Int((turn * Double(RadialMenu.slotCount)).rounded())
        return slot % RadialMenu.slotCount
    }
}
