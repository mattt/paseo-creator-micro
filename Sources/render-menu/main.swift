// Renders the menu's sample states to PNG files, for development.
//
//     swift run render-menu <folder>
//
// The samples use made-up data. The tool starts no session and touches no socket, port, or keypad.
import AppKit
import CreatorMicro
import PaseoMicroCore
import PaseoMicroMenu
import SwiftUI

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: render-menu <folder>\n".utf8))
    exit(2)
}
let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

/// The lights of a keypad with navigation on the top keys and one agent that needs input.
let lights: DesiredLights = {
    var lights = DesiredLights()
    let white = LightColor(packed: 0xD8D8D8)
    lights.set((0 ..< 6).map { KeyLight(key: $0, color: white, brightness: 0.2) })
    lights.set([KeyLight(key: 6, color: LightColor(packed: 0xFFC800), brightness: 1, effect: .breathing)])
    lights.zones = ZoneLights(keys: ZoneLight(color: white, brightness: 0.1))
    return lights
}()

func connected(layer: Int = 2, battery: Int = 64, charging: Bool = false) -> KeypadState {
    KeypadState(
        connected: true,
        transport: "USB",
        firmware: "0.6.3",
        layer: layer,
        battery: battery,
        charging: charging,
        inputLayers: [2, 4],
        lightableKeys: [2: Set(0 ... 6)]
    )
}

func base(_ keypad: KeypadState) -> MenuState {
    var state = MenuState(keypad: keypad, lights: lights)
    state.launchAtLogin = true
    state.clients = ["node pid 4242"]
    state.mcpURL = URL(string: "http://127.0.0.1:7655/mcp")
    return state
}

struct Sample {
    var name: String
    var state: MenuState
    var showsDetails = false
}

let samples: [Sample] = {
    var charging = base(connected(battery: 15, charging: true))
    charging.lastInput = .key(KeyInput(key: 6, action: .press))

    var disconnected = base(.disconnected)
    disconnected.lights = DesiredLights()

    var warning = base(connected(layer: 1, battery: 12))
    warning.accessibilityTrusted = false
    warning.launchAtLogin = false

    var details = charging
    details.keypad = connected()

    return [
        Sample(name: "connected", state: base(connected())),
        Sample(name: "charging", state: charging),
        Sample(name: "not-connected", state: disconnected),
        Sample(name: "warning", state: warning),
        Sample(name: "details", state: details, showsDetails: true),
    ]
}()

for sample in samples {
    for (scheme, contrast, suffix) in [
        (ColorScheme.light, ColorSchemeContrast.standard, "light"),
        (.dark, .standard, "dark"),
        (.light, .increased, "light-contrast"),
        (.dark, .increased, "dark-contrast"),
    ] {
        try MainActor.assumeIsolated {
            let view = MenuContent(state: sample.state, showsDetails: sample.showsDetails) { _ in }
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
                .environment(\._colorSchemeContrast, contrast)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            guard let image = renderer.cgImage,
                let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
            else {
                throw CocoaError(.fileWriteUnknown)
            }
            try data.write(to: folder.appendingPathComponent("\(sample.name)-\(suffix).png"))
        }
    }
}
print("Rendered \(samples.count * 4) images to \(folder.path)")
