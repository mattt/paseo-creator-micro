import CreatorMicro
import Foundation
import PaseoMicroCore
import PaseoMicroMenu
import Testing

@Suite("Menu state")
struct MenuStateTests {
    private func connected(layer: Int? = 4, battery: Int? = 64, charging: Bool? = false, layers: Set<Int> = [2, 4])
        -> KeypadState
    {
        KeypadState(
            connected: true,
            transport: "USB",
            layer: layer,
            battery: battery,
            charging: charging,
            inputLayers: layers
        )
    }

    @Test("The header says whether the keypad is connected, in title case")
    func status() {
        #expect(MenuState(keypad: connected()).statusText == "Connected via USB")
        #expect(MenuState(keypad: .disconnected).statusText == "Not Connected")
    }

    @Test("A keypad on a Paseo layer with permissions has no warnings")
    func noNotices() {
        #expect(MenuState(keypad: connected()).notices.isEmpty)
        #expect(MenuState(keypad: .disconnected).notices.isEmpty)
    }

    @Test("A layer without controls names the layers that have them")
    func layerNotice() {
        #expect(
            MenuState(keypad: connected(layer: 1)).notices.map(\.message) == [
                "This keypad layer has no Paseo controls. Switch to layer 2 or 4."
            ]
        )
        #expect(
            MenuState(keypad: connected(layer: 1, layers: [4])).notices.first?.message
                == "This keypad layer has no Paseo controls. Switch to layer 4."
        )
        #expect(
            MenuState(keypad: connected(layer: 1, layers: [])).notices.first?.message
                == "No keypad layer has Paseo controls."
        )
        #expect(MenuState(keypad: connected(layer: nil)).notices.isEmpty)
    }

    @Test("ChatGPT on its layer asks the person to quit it")
    func chatGPTNotice() {
        let keypad = KeypadState(connected: true, layer: 4, inputLayers: [4], chatGPTRunning: true)
        #expect(MenuState(keypad: keypad).notices.map(\.id) == ["chatgpt"])
    }

    @Test("A missing permission offers its settings")
    func permissionNotices() {
        var state = MenuState(keypad: connected())
        state.accessibilityTrusted = false
        state.escapeTapProblem = .accessibility
        #expect(state.notices.map(\.id) == ["accessibility"])
        #expect(state.notices.first?.action?.action == .openAccessibilitySettings)

        state.accessibilityTrusted = true
        #expect(state.notices.map(\.id) == ["escape"])
        #expect(state.notices.first?.action == nil)

        state.escapeTapProblem = .inputMonitoring
        #expect(state.notices.first?.action?.action == .openInputMonitoringSettings)
    }

    @Test("The login item's approval offers its settings")
    func loginNotices() {
        var state = MenuState(keypad: connected())
        state.launchAtLoginNeedsApproval = true
        state.launchAtLoginError = "Nope."
        #expect(state.notices.map(\.id) == ["login-approval", "login-error"])
        #expect(state.notices.first?.action?.action == .openLoginItemsSettings)
    }

    @Test("Warnings avoid internal words, which Details keeps")
    func plainWords() {
        var state = MenuState(keypad: connected(layer: 1))
        state.accessibilityTrusted = false
        state.bridgeError = "bridge.sock is in use"
        state.mcpError = "Port 7655 is not available"
        state.escapeTapProblem = .refused
        state.launchAtLoginNeedsApproval = true
        let words = state.notices.map(\.message).joined(separator: " ").lowercased()
        for word in ["bridge", "socket", "thread", "mcp", "tap"] {
            #expect(!words.contains(word))
        }
        #expect(state.detailRows.last?.value == "bridge.sock is in use")
        #expect(state.mcpText == "Port 7655 is not available")
    }

    @Test(
        "The battery's symbol follows its charge",
        arguments: [
            (5, false, "battery.0percent"), (30, false, "battery.25percent"), (50, false, "battery.50percent"),
            (80, false, "battery.75percent"), (100, false, "battery.100percent"),
            (40, true, "battery.100percent.bolt"),
        ]
    )
    func batterySymbol(percent: Int, charging: Bool, symbol: String) {
        #expect(BatteryIndicator(percent: percent, charging: charging).symbolName == symbol)
    }

    @Test("The battery always shows while connected")
    func batteryAlwaysShown() {
        #expect(MenuState(keypad: connected(battery: 64)).battery?.text == "64%")
        #expect(MenuState(keypad: connected(battery: 100)).battery?.text == "100%")
    }

    @Test(
        "The header says how the keypad is connected",
        arguments: [
            ("USB", "Connected via USB"), ("Bluetooth", "Connected via Bluetooth"),
            ("Bluetooth Low Energy", "Connected via Bluetooth"), ("", "Connected"),
        ]
    )
    func statusText(transport: String, text: String) {
        var keypad = connected()
        keypad.transport = transport
        #expect(MenuState(keypad: keypad).statusText == text)
        #expect(MenuState(keypad: .disconnected).statusText == "Not Connected")
    }

    @Test("The battery is not shown without a keypad")
    func batteryDisconnected() {
        var keypad = KeypadState.disconnected
        keypad.battery = 5
        #expect(MenuState(keypad: keypad).battery == nil)
        #expect(MenuState(keypad: connected(battery: 5)).battery?.isLow == true)
        #expect(MenuState(keypad: connected(battery: 5, charging: true)).battery?.isLow == false)
    }

    @Test("Details list the connection, the layer, the lighting, the last input, and the clients")
    func details() {
        var state = MenuState(keypad: connected())
        state.lastInput = .dial(.press)
        state.mcpURL = URL(string: "http://127.0.0.1:7655/mcp")
        #expect(
            state.detailRows.map(\.title) == [
                "Firmware", "Layer", "Lighting", "Last Input", "Clients",
            ]
        )
        #expect(state.detailRows[2].value == "Not paused")
        #expect(state.detailRows[4].value == "None")
        #expect(state.mcpText == "http://127.0.0.1:7655/mcp")
        state.clients = ["one", "two"]
        #expect(state.detailRows[4].value == "one, two")
    }

    @Test("A key shows as down only between its press and its release, while connected")
    func pressedKey() {
        var state = MenuState(keypad: connected())
        #expect(state.pressedKey == nil)
        state.lastInput = .key(KeyInput(key: 6, action: .press))
        #expect(state.pressedKey == 6)
        state.lastInput = .key(KeyInput(key: 6, action: .release))
        #expect(state.pressedKey == nil)
        state.lastInput = .dial(.press)
        #expect(state.pressedKey == nil)
        state.lastInput = .key(KeyInput(key: 13, action: .press))
        #expect(state.pressedKey == nil)
        state.lastInput = .key(KeyInput(key: 6, action: .press))
        state.keypad = .disconnected
        #expect(state.pressedKey == nil)
    }

    @Test("Only the layer's keys show their own lights, and any key may while the layer is unknown")
    func lightableKeys() {
        let keypad = KeypadState(connected: true, layer: 2, inputLayers: [2], lightableKeys: [2: [0, 6]])
        #expect(MenuState(keypad: keypad).lightableKeys == [0, 6])
        #expect(MenuState(keypad: connected(layer: 1)).lightableKeys == [])
        #expect(MenuState(keypad: connected(layer: nil)).lightableKeys == nil)
        #expect(MenuState(keypad: .disconnected).lightableKeys == nil)
    }

    @Test(
        "Keys describe colors in words",
        arguments: [
            (0xFF2D2D, "red"), (0xFFC800, "yellow"), (0x00FF00, "green"), (0x2D7DFF, "blue"), (0xFFFFFF, "white"),
            (0xFF8800, "orange"), (0x9933FF, "purple"), (0x000000, "off"), (0x2DD4BF, "teal"),
        ]
    )
    func colorNames(packed: Int, name: String) {
        #expect(KeyDescription.colorName(LightColor(packed: packed)) == name)
    }

    @Test("Key descriptions have no color codes")
    func keyDescriptions() {
        let green = LightColor(packed: 0x00FF00)
        let breathing = KeyLight(key: 3, color: green, effect: .breathing)
        #expect(
            KeyDescription.text(key: 3, name: "3", light: breathing, shown: green, lightable: true)
                == "Key 3, green, breathing"
        )
        #expect(KeyDescription.text(key: 3, name: "3", light: nil, shown: nil, lightable: true) == "Key 3, off")
        #expect(
            KeyDescription.text(key: 7, name: "7", light: nil, shown: nil, lightable: false)
                == "Key 7, off, no light of its own on this layer"
        )
    }
}
