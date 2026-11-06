/// A warning in the menu: something that a person can act on, in plain language.
public struct MenuNotice: Hashable, Sendable, Identifiable {
    /// The button that a notice offers.
    public struct Action: Hashable, Sendable {
        /// The button's title.
        public var title: String
        /// What the button does.
        public var action: MenuAction
    }

    /// A stable identifier for the condition.
    public var id: String
    /// What is wrong and what to do.
    public var message: String
    /// The notice's button, when the app can help.
    public var action: Action?
}

extension MenuState {
    /// The warnings to show, most important first.
    public var notices: [MenuNotice] {
        var notices: [MenuNotice] = []
        if keypad.connected, keypad.layer != nil, !keypad.isOnInputLayer {
            notices.append(MenuNotice(id: "layer", message: layerMessage))
        }
        if keypad.connected, keypad.lightsPaused {
            notices.append(
                MenuNotice(
                    id: "chatgpt",
                    message: "ChatGPT controls the lights on this keypad layer. Quit ChatGPT to see your agents."
                )
            )
        }
        if !accessibilityTrusted {
            notices.append(
                MenuNotice(
                    id: "accessibility",
                    message:
                        "Turn on Accessibility for Paseo Micro so the keypad can send shortcuts and scroll. If it's already on, turn it off and on again.",
                    action: .init(title: "Open Accessibility Settings", action: .openAccessibilitySettings)
                )
            )
        }
        if let escape = escapeNotice { notices.append(escape) }
        if bridgeError != nil {
            notices.append(
                MenuNotice(
                    id: "plugin",
                    message: "Paseo can't reach this app. Quit any other copy of Paseo Micro, then open this one again."
                )
            )
        }
        if launchAtLoginNeedsApproval {
            notices.append(
                MenuNotice(
                    id: "login-approval",
                    message: "Turn on Paseo Micro in Login Items to open it when you log in.",
                    action: .init(title: "Open Login Items Settings", action: .openLoginItemsSettings)
                )
            )
        }
        if let launchAtLoginError {
            notices.append(
                MenuNotice(
                    id: "login-error",
                    message: "Launch at Login didn't change. \(launchAtLoginError)"
                )
            )
        }
        return notices
    }

    private var layerMessage: String {
        let layers = keypad.inputLayers
        guard let last = layers.last else { return "No keypad layer has Paseo controls." }
        let list = layers.dropLast().map(String.init).joined(separator: ", ")
        let target = layers.count == 1 ? "layer \(last)" : "layer \(list) or \(last)"
        return "This keypad layer has no Paseo controls. Switch to \(target)."
    }

    private var escapeNotice: MenuNotice? {
        switch escapeTapProblem {
        case nil:
            return nil
        case .accessibility:
            // Without Accessibility, that notice covers Escape too.
            guard accessibilityTrusted else { return nil }
            return MenuNotice(
                id: "escape",
                message: "Escape couldn't close the radial menu. Open the radial menu again to retry."
            )
        case .inputMonitoring:
            return MenuNotice(
                id: "escape",
                message: "Turn on Input Monitoring for Paseo Micro so Escape can close the radial menu.",
                action: .init(title: "Open Input Monitoring Settings", action: .openInputMonitoringSettings)
            )
        case .refused:
            return MenuNotice(
                id: "escape",
                message: "Escape can't close the radial menu. To cancel, return the stick slowly to the center."
            )
        }
    }
}
