import CreatorMicro
import Foundation
import PaseoMicroCore

/// Why Escape cannot close the radial menu: the app could not install its keyboard event tap.
public enum EscapeTapProblem: Hashable, Sendable {
    /// The app lacks the Accessibility permission, which a tap needs to see key events.
    case accessibility
    /// The app has the Accessibility permission but not Input Monitoring.
    case inputMonitoring
    /// macOS refused the tap for another reason.
    case refused
}

/// Something that the menu asks the app to do.
public enum MenuAction: Hashable, Sendable {
    /// Asks for the Accessibility permission and opens its settings.
    case openAccessibilitySettings
    /// Asks for the Input Monitoring permission and opens its settings.
    case openInputMonitoringSettings
    /// Opens Login Items in System Settings.
    case openLoginItemsSettings
    /// Turns the login item on or off.
    case setLaunchAtLogin(Bool)
    /// Brings Paseo to the front.
    case openPaseo
    /// Shows the About panel.
    case showAbout
    /// Quits the app.
    case quit
    /// Puts text on the pasteboard.
    case copy(String)
}

/// Everything that the menu shows, apart from the app, so that samples can draw it.
public struct MenuState: Sendable {
    /// The keypad's state.
    public var keypad: KeypadState
    /// The lights to draw.
    public var lights: DesiredLights
    /// The most recent input.
    public var lastInput: KeypadInput?
    /// A description of each program connected to the keypad app.
    public var clients: [String] = []
    /// Why programs cannot connect to the keypad app, if the app failed to listen.
    public var bridgeError: String?
    /// The MCP address, once it listens.
    public var mcpURL: URL?
    /// Why the MCP server does not listen, if it failed.
    public var mcpError: String?
    /// Whether the app has the Accessibility permission.
    public var accessibilityTrusted = true
    /// Why Escape cannot close the radial menu, if it cannot.
    public var escapeTapProblem: EscapeTapProblem?
    /// Whether the login item is on.
    public var launchAtLogin = false
    /// Whether people can change the login item, which needs the app in an Applications folder.
    public var launchAtLoginAvailable = true
    /// Whether macOS needs approval for the login item.
    public var launchAtLoginNeedsApproval = false
    /// Why the last change to the login item failed, if it did.
    public var launchAtLoginError: String?
    /// Whether Paseo is installed.
    public var paseoInstalled = true

    /// Creates a state with no problems.
    ///
    /// - Parameters:
    ///   - keypad: The keypad's state.
    ///   - lights: The lights to draw.
    public init(keypad: KeypadState, lights: DesiredLights = DesiredLights()) {
        self.keypad = keypad
        self.lights = lights
    }

    /// The connection, as a word or two for the header.
    public var statusText: String {
        keypad.connected ? "Connected" : "Not Connected"
    }

    /// The battery charge to show, when it is useful.
    public var battery: BatteryIndicator? {
        guard keypad.connected, let percent = keypad.battery else { return nil }
        return BatteryIndicator(percent: percent, charging: keypad.charging == true)
    }

    /// The keys that show their own lights on the keypad's layer,
    /// or `nil` while the layer is unknown, when the drawing treats every key as able to.
    public var lightableKeys: Set<Int>? {
        keypad.connected && keypad.layer != nil ? keypad.litKeysOnLayer : nil
    }

    /// The key that is down, from the most recent input.
    public var pressedKey: Int? {
        guard keypad.connected, case .key(let input) = lastInput, input.action == .press, input.key < KeyInput.count
        else { return nil }
        return input.key
    }

    /// The rows of the Details section, in order.
    public var detailRows: [MenuDetailRow] {
        [
            MenuDetailRow(title: "Connection", value: keypad.transport ?? "—"),
            MenuDetailRow(title: "Battery", value: batteryText),
            MenuDetailRow(title: "Firmware", value: keypad.firmware ?? "—"),
            MenuDetailRow(title: "Layer", value: keypad.layerDescription),
            MenuDetailRow(title: "Lighting", value: lighting),
            MenuDetailRow(title: "Last Input", value: lastInput.map(String.init(describing:)) ?? "—"),
            MenuDetailRow(title: "Clients", value: clientsText),
        ]
    }

    /// The text of the MCP row: the address, or why there is none.
    public var mcpText: String {
        mcpURL?.absoluteString ?? mcpError ?? "—"
    }

    private var batteryText: String {
        guard keypad.connected, let percent = keypad.battery else { return "—" }
        switch keypad.charging {
        case true?: return "\(percent)%, charging"
        case false?: return "\(percent)%, not charging"
        case nil: return "\(percent)%"
        }
    }

    private var lighting: String {
        guard keypad.connected else { return "—" }
        let status = keypad.lightingStatus
        return status.prefix(1).uppercased() + status.dropFirst()
    }

    private var clientsText: String {
        if let bridgeError { return bridgeError }
        return clients.isEmpty ? "None" : clients.joined(separator: ", ")
    }
}

/// One row of the Details section.
public struct MenuDetailRow: Hashable, Sendable {
    /// The row's title.
    public var title: String
    /// The row's value.
    public var value: String

    /// Creates a row.
    ///
    /// - Parameters:
    ///   - title: The row's title.
    ///   - value: The row's value.
    public init(title: String, value: String) {
        self.title = title
        self.value = value
    }
}

/// The battery charge in the menu's header, which shows only when the battery is low or charging.
public struct BatteryIndicator: Hashable, Sendable {
    /// The charge at or below which the battery counts as low, in percent.
    public static let lowPercent = 20

    /// The charge, in percent.
    public var percent: Int
    /// Whether the battery is charging.
    public var charging: Bool

    /// Creates an indicator, if the charge is useful to show.
    ///
    /// - Parameters:
    ///   - percent: The charge, in percent.
    ///   - charging: Whether the battery is charging.
    /// - Returns: The indicator, or `nil` for a battery that is full or not low and not charging.
    public init?(percent: Int, charging: Bool) {
        guard percent <= Self.lowPercent || (charging && percent < 100) else { return nil }
        self.percent = percent
        self.charging = charging
    }

    /// Whether the indicator warns that the battery is low.
    public var isLow: Bool {
        !charging && percent <= Self.lowPercent
    }

    /// The SF Symbol for the charge.
    public var symbolName: String {
        if charging { return "battery.100percent.bolt" }
        return percent <= 10 ? "battery.0percent" : "battery.25percent"
    }

    /// The charge, as the header shows it.
    public var text: String {
        "\(percent)%"
    }

    /// The charge, as VoiceOver reads it.
    public var accessibilityLabel: String {
        charging ? "Battery \(percent) percent, charging" : "Battery \(percent) percent"
    }
}
