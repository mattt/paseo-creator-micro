import CreatorMicro
import PaseoMicroCore
import SwiftUI

/// The content of the menu bar window.
struct MenuView: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            warnings
            KeypadView(
                lights: model.lights,
                lightableKeys: model.keypad.connected && model.keypad.isOnInputLayer
                    ? model.keypad.litKeysOnLayer : nil,
                connected: model.keypad.connected,
                onTap: model.emulator.map { keypad in { keypad.tap(key: $0) } }
            )
            details
            if let emulator = model.emulator {
                EmulatorControls(keypad: emulator)
            }
            Divider()
            options
            Divider()
            commands
        }
        .padding(14)
        .frame(width: 320)
        .onAppear { model.refreshEnvironment() }
    }

    private var header: some View {
        HStack {
            Text("Paseo Micro").font(.headline)
            Spacer()
            Label(
                model.keypad.connected ? "Connected" : "Not connected",
                systemImage: model.keypad.connected ? "circle.fill" : "circle"
            )
            .font(.caption)
            .foregroundStyle(model.keypad.connected ? .green : .secondary)
        }
    }

    @ViewBuilder
    private var warnings: some View {
        if model.keypad.connected, model.keypad.lightsPaused {
            warning(
                "Lighting is \(model.keypad.lightingStatus), so Paseo Micro leaves this layer's lights to Codex. It keeps the lights that agents ask for and sends them when the keypad leaves the layer or ChatGPT quits. Inputs still arrive."
            )
        } else if model.chatGPTRunning, model.emulator != nil {
            warning("The ChatGPT app is running. It does not reach the emulated keypad.")
        }
        if model.keypad.connected, let layer = model.keypad.layer, !model.keypad.isOnInputLayer {
            warning(
                "The keypad is on layer \(layer). Key lights and inputs need a Paseo layer: \(model.keypad.inputLayerList)."
            )
        }
        if !model.accessibilityTrusted {
            VStack(alignment: .leading, spacing: 4) {
                warning(
                    "Paseo Micro does not have the Accessibility permission, which keyboard shortcuts, scrolling, and Escape on the radial menu need. Turn on Paseo Micro in System Settings > Privacy & Security > Accessibility. If it is on already, turn it off and on again."
                )
                Button("Open Accessibility Settings") { model.requestAccessibility() }
                    .controlSize(.small)
            }
        }
        switch model.escapeTapProblem {
        case nil:
            EmptyView()
        case .accessibility:
            // Without Accessibility, the warning above covers Escape too.
            if model.accessibilityTrusted {
                warning(
                    "Escape could not close the radial menu without the Accessibility permission. Open the radial menu again to retry."
                )
            }
        case .inputMonitoring:
            VStack(alignment: .leading, spacing: 4) {
                warning(
                    "Escape cannot close the radial menu without the Input Monitoring permission: System Settings > Privacy & Security > Input Monitoring, then turn on Paseo Micro. Return the stick slowly to the center to cancel instead."
                )
                Button("Open Input Monitoring Settings") { model.requestInputMonitoring() }
                    .controlSize(.small)
            }
        case .refused:
            warning(
                "macOS refused the keyboard tap that lets Escape close the radial menu. Return the stick slowly to the center to cancel instead."
            )
        }
        if let error = model.bridgeError { warning("Bridge: \(error)") }
        if let error = model.mcpError { warning("MCP: \(error)") }
    }

    /// The settings: launch at login and the emulated keypad.
    @ViewBuilder
    private var options: some View {
        let login = model.launchAtLogin
        VStack(alignment: .leading, spacing: 6) {
            Toggle("Launch at Login", isOn: Binding(get: { login.isEnabled }, set: { login.setEnabled($0) }))
                .disabled(!login.isInstalled && !login.isEnabled)
                .help(
                    login.isInstalled
                        ? "Open Paseo Micro when you log in"
                        : "Install Paseo Micro in /Applications to open it at login"
                )
            if !login.isInstalled {
                Text("Paseo Micro runs from a build folder. Install it in /Applications to open it at login.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if login.needsApproval {
                VStack(alignment: .leading, spacing: 4) {
                    warning(
                        "macOS needs your approval to open Paseo Micro at login: turn it on in System Settings > General > Login Items & Extensions."
                    )
                    Button("Open Login Items Settings") { login.openSettings() }
                        .controlSize(.small)
                }
            }
            if let error = login.error { warning("Launch at Login: \(error)") }
            Toggle("Use emulated keypad", isOn: $model.usesEmulator)
                .disabled(model.emulationForced)
                .help(model.emulationForced ? "Set by PASEO_MICRO_EMULATED" : "Use a keypad in software instead of USB")
        }
    }

    /// The commands, grouped as in a menu: other apps and files, then this app.
    private var commands: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button("Open Paseo Settings") { AppInfo.openPaseo() }
                .disabled(AppInfo.paseo == nil)
                .help(
                    AppInfo.paseo == nil
                        ? "Paseo is not installed"
                        : "Bring Paseo to the front; the plugin's settings are in Settings > Plugins > Creator Micro"
                )
            if AppInfo.readme != nil {
                Button("Show README") { AppInfo.openReadme() }
                    .help("Open README.md from the repository")
            }
            Divider().padding(.vertical, 4)
            Button("About Paseo Micro") { AppInfo.showAbout() }
            Button {
                model.quit()
            } label: {
                HStack {
                    Text("Quit Paseo Micro")
                    Spacer()
                    Text("⌘Q").foregroundStyle(.secondary)
                }
            }
            .keyboardShortcut("q")
        }
        .buttonStyle(MenuItemButtonStyle())
        .padding(.horizontal, -MenuItemButtonStyle.inset)
    }

    private func warning(_ text: String) -> some View {
        Label {
            Text(text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
        }
        .font(.caption)
    }

    private var details: some View {
        Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 4) {
            row("Connection", model.keypad.transport ?? "—")
            row("Firmware", model.keypad.firmware ?? "—")
            row("Layer", model.keypad.layerDescription)
            row("Lighting", lighting)
            row("Battery", battery)
            row("Last input", model.lastInput.map(String.init(describing:)) ?? "—")
            row("Bridge", bridge)
            row("MCP", model.mcpURL?.absoluteString ?? "—")
        }
        .font(.caption)
        .textSelection(.enabled)
    }

    private var lighting: String {
        guard model.keypad.connected else { return "—" }
        let status = model.keypad.lightingStatus
        return status.prefix(1).uppercased() + status.dropFirst()
    }

    private var battery: String {
        guard let battery = model.keypad.battery else { return "—" }
        return model.keypad.charging == true ? "\(battery)%, charging" : "\(battery)%"
    }

    private var bridge: String {
        guard model.bridgePath != nil else { return "—" }
        let clients = model.bridgeClients
        if clients.isEmpty { return "No clients" }
        let names = clients.map { client in
            [client.processName, client.processID.map { "pid \($0)" }].compactMap(\.self).joined(separator: " ")
        }
        return "\(clients.count) client\(clients.count == 1 ? "" : "s"): " + names.joined(separator: ", ")
    }

    private func row(_ title: String, _ value: String) -> some View {
        GridRow {
            Text(title).foregroundStyle(.secondary)
            Text(value).lineLimit(2)
        }
    }
}

/// Buttons that send inputs from the emulated keypad.
struct EmulatorControls: View {
    let keypad: EmulatedKeypad

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Emulator: click a key to tap it").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Dial ↺") { keypad.turnDial(clockwise: false) }
                Button("Dial ↻") { keypad.turnDial(clockwise: true) }
                Button("Click") { keypad.clickDial() }
                Button("Flick ↑") { flickJoystick() }
            }
            HStack {
                Button("Layer 1") { keypad.setLayer(1) }
                Button("Layer 4") { keypad.setLayer(4) }
                Button(keypad.isPluggedIn ? "Unplug" : "Plug in") {
                    if keypad.isPluggedIn { keypad.unplug() } else { keypad.plugIn() }
                }
            }
        }
        .controlSize(.small)
    }

    /// Pushes the stick up and lets it spring back, as a release does, which picks the radial menu's top slot.
    private func flickJoystick() {
        Task {
            for distance in [0.6, 1.0] {
                keypad.moveJoystick(angle: 0.25, distance: distance, sector: 0)
                try? await Task.sleep(for: .milliseconds(150))
            }
            keypad.moveJoystick(angle: 0.25, distance: 0.3, sector: 0)
            keypad.moveJoystick(angle: 0, distance: 0, sector: -1)
        }
    }
}

/// A button that looks like a menu item: as wide as the menu, highlighted under the pointer.
struct MenuItemButtonStyle: ButtonStyle {
    /// The space between the highlight's edge and the title.
    static let inset: CGFloat = 6

    func makeBody(configuration: Configuration) -> some View {
        Item(configuration: configuration)
    }

    private struct Item: View {
        let configuration: Configuration
        @State private var hovering = false
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let highlighted = isEnabled && (hovering || configuration.isPressed)
            configuration.label
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, MenuItemButtonStyle.inset)
                .padding(.vertical, 3)
                .foregroundStyle(highlighted ? AnyShapeStyle(.white) : AnyShapeStyle(isEnabled ? .primary : .tertiary))
                .background(RoundedRectangle(cornerRadius: 4).fill(highlighted ? Color.accentColor : .clear))
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}
