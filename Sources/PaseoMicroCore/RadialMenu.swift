import Foundation

/// A radial menu of eight slots that the joystick picks from, as a bridge client defines it.
///
/// Slot 0 is up, and the others follow clockwise: up-right, right, down-right, down,
/// down-left, left, and up-left.
/// The app draws the menu and reports the slot that the joystick picks;
/// the client decides what each slot does.
/// The `Codable` form is the bridge's form, such as
/// `{"slots":[{"icon":"checkmark.circle","label":"Approve","color":"#34C759","enabled":true},…],"target":"Fix the build"}`.
public struct RadialMenu: Sendable, Hashable, Codable {
    /// The number of slots: the four cardinal and four diagonal directions.
    public static let slotCount = 8

    /// The bundle identifier of the app over whose frontmost window the menu appears
    /// when a definition names none: Paseo's desktop app.
    public static let defaultBundleID = "sh.paseo.desktop"

    /// The slots, clockwise from up.
    public var slots: [RadialMenuSlot]
    /// The name of the agent that the menu acts on, shown in the ring's center, or `nil` for none.
    public var target: String?
    /// The app over whose frontmost window the menu appears, or `nil` for ``defaultBundleID``.
    public var bundleID: String?

    /// Creates a menu definition.
    ///
    /// - Parameters:
    ///   - slots: The slots, clockwise from up; a valid menu has ``slotCount``.
    ///   - target: The name of the agent that the menu acts on, or `nil` for none.
    ///   - bundleID: The app over whose frontmost window the menu appears, or `nil` for Paseo.
    public init(slots: [RadialMenuSlot], target: String? = nil, bundleID: String? = nil) {
        self.slots = slots
        self.target = target
        self.bundleID = bundleID
    }

    /// Checks the definition before the app shows it.
    ///
    /// - Throws: ``RadialMenuError`` when the menu does not have ``slotCount`` slots,
    ///   or a slot has an icon outside ``RadialMenuSlot/icons``, an empty or long label,
    ///   or a color that is not `#RRGGBB`.
    public func validate() throws {
        guard slots.count == Self.slotCount else { throw RadialMenuError.slotCount(slots.count) }
        for (index, slot) in slots.enumerated() {
            try slot.validate(index: index)
        }
    }

    /// The app over whose frontmost window the menu appears.
    public var effectiveBundleID: String {
        guard let bundleID, !bundleID.isEmpty else { return Self.defaultBundleID }
        return bundleID
    }
}

/// One slot of a ``RadialMenu``.
public struct RadialMenuSlot: Sendable, Hashable, Codable {
    /// The SF Symbols that a slot may show: a short list of clearly different shapes,
    /// so that each slot is easy to tell apart at a glance.
    ///
    /// The plugin's settings offer the same list (`RADIAL_MENU_ICONS` in `Plugin/shared/radial-menu.ts`),
    /// and a test checks that the two lists match.
    public static let icons: [String] = [
        "checkmark.circle",
        "xmark.circle",
        "play.circle",
        "stop.circle",
        "pause.circle",
        "testtube.2",
        "magnifyingglass",
        "arrow.triangle.branch",
        "list.bullet",
        "arrow.down.to.line",
        "arrow.uturn.backward",
        "arrow.uturn.backward.circle",
        "arrow.uturn.forward.circle",
        "arrow.clockwise",
        "sparkles",
        "hammer",
        "ant",
        "doc.text",
        "text.bubble",
        "questionmark.circle",
        "lightbulb",
        "flag",
        "trash",
        "paperplane",
        "mic",
        "brain",
        "bolt",
        "terminal",
        "shippingbox",
        "eye",
        "pencil",
        "folder",
        "star",
        "bookmark",
    ]

    /// The longest label, in characters: room for one or two short words.
    public static let maximumLabelLength = 20

    /// The SF Symbol's name, one of ``icons``.
    public var icon: String
    /// The label under the icon: one or two words.
    public var label: String
    /// The slot's color as `#RRGGBB`, or `nil` for the menu's default color.
    public var color: String?
    /// Whether the slot can act now; the app draws a slot that cannot act dimmed and never picks it.
    public var enabled: Bool

    /// Creates a slot.
    ///
    /// - Parameters:
    ///   - icon: The SF Symbol's name, one of ``icons``.
    ///   - label: The label under the icon.
    ///   - color: The slot's color as `#RRGGBB`, or `nil` for the default.
    ///   - enabled: Whether the slot can act now.
    public init(icon: String, label: String, color: String? = nil, enabled: Bool = true) {
        self.icon = icon
        self.label = label
        self.color = color
        self.enabled = enabled
    }

    /// The color's red, green, and blue components from 0 to 1, or `nil` without a valid color.
    public var rgb: (red: Double, green: Double, blue: Double)? {
        guard let color, Self.isHexColor(color), let value = UInt32(color.dropFirst(), radix: 16) else { return nil }
        return (
            Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255
        )
    }

    fileprivate func validate(index: Int) throws {
        guard Self.icons.contains(icon) else { throw RadialMenuError.unknownIcon(slot: index, icon: icon) }
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, label.count <= Self.maximumLabelLength else {
            throw RadialMenuError.invalidLabel(slot: index, label: label)
        }
        if let color, !Self.isHexColor(color) { throw RadialMenuError.invalidColor(slot: index, color: color) }
    }

    private static func isHexColor(_ text: String) -> Bool {
        text.utf8.count == 7 && text.hasPrefix("#") && text.dropFirst().allSatisfy(\.isHexDigit)
    }
}

/// Why the app refuses a radial menu definition.
public enum RadialMenuError: Error, Sendable, Hashable, CustomStringConvertible {
    /// The menu does not have ``RadialMenu/slotCount`` slots.
    case slotCount(Int)
    /// A slot's icon is not one of ``RadialMenuSlot/icons``.
    case unknownIcon(slot: Int, icon: String)
    /// A slot's label is empty or longer than ``RadialMenuSlot/maximumLabelLength``.
    case invalidLabel(slot: Int, label: String)
    /// A slot's color is not `#RRGGBB`.
    case invalidColor(slot: Int, color: String)

    public var description: String {
        switch self {
        case .slotCount(let count): "A radial menu needs \(RadialMenu.slotCount) slots, not \(count)"
        case .unknownIcon(let slot, let icon):
            "Slot \(slot) has the icon \"\(icon)\", which is not one of the radial menu's icons"
        case .invalidLabel(let slot, let label):
            "Slot \(slot) has the label \"\(label)\"; use 1 to \(RadialMenuSlot.maximumLabelLength) characters"
        case .invalidColor(let slot, let color): "Slot \(slot) has the color \"\(color)\"; use #RRGGBB"
        }
    }
}
