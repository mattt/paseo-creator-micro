import AppKit
import CreatorMicro
import PaseoMicroCore
import PaseoMicroMenu
import SwiftUI

/// The content of the menu bar window, which connects the menu's views to the app.
struct MenuView: View {
    let model: AppModel

    /// Whether Option is down, which reveals the Details section.
    @State private var optionHeld = NSEvent.modifierFlags.contains(.option)

    var body: some View {
        MenuContent(
            state: model.menuState,
            showsDetails: optionHeld,
            onKeyTap: model.emulator.map { keypad in { keypad.tap(key: $0) } },
            perform: perform
        ) {
            if let emulator = model.emulator {
                EmulatorControls(keypad: emulator)
            }
        }
        .onAppear { model.refreshEnvironment() }
        .task { await followOptionKey() }
    }

    /// Reads Option while the menu shows.
    ///
    /// The window of a menu bar extra can show while the app is inactive, so flag-change events
    /// may not arrive; `NSEvent.modifierFlags` reports the keys independently of event delivery.
    private func followOptionKey() async {
        while !Task.isCancelled {
            let held = NSEvent.modifierFlags.contains(.option)
            if held != optionHeld { optionHeld = held }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    private func perform(_ action: MenuAction) {
        switch action {
        case .openAccessibilitySettings: model.requestAccessibility()
        case .openInputMonitoringSettings: model.requestInputMonitoring()
        case .openLoginItemsSettings: model.launchAtLogin.openSettings()
        case .setLaunchAtLogin(let enabled): model.launchAtLogin.setEnabled(enabled)
        case .openPaseo: AppInfo.openPaseo()
        case .showAbout: AppInfo.showAbout()
        case .quit: model.quit()
        case .copy(let text):
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }
}

/// Buttons that send inputs from the emulated keypad, for development with `PASEO_MICRO_EMULATED=1`.
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
