import CreatorMicro
import Foundation
import PaseoMicroCore
import SwiftUI

extension EnvironmentValues {
    /// The moment at which to draw the keypad's animated lights, or `nil` to follow the clock.
    @Entry public var keypadLightTime: TimeInterval? = nil
}

/// A simplified drawing of the keypad, seen from above, whose lights follow the app's desired lights.
///
/// Each key shows its own light, or faintly the `keys` zone,
/// and the light ring and the outer glow show the `ambient` zone.
/// Details add each key's number,
/// and a dashed outline to a key that cannot show its own light on the keypad's layer.
public struct KeypadView: View {
    /// The lights to show.
    public var lights: DesiredLights
    /// The keys that show per-key lights on the keypad's layer,
    /// or `nil` to draw every key as able to (as when the layer is unknown).
    public var lightableKeys: Set<Int>?
    /// Whether the keypad is connected; the drawing is dark and dimmed when it is not.
    public var connected: Bool
    /// The key that is down, if any.
    public var pressedKey: Int?
    /// Whether each key shows its number and whether it has a light of its own.
    public var showsKeyDetails: Bool
    /// Called when a key is clicked, or `nil` if keys are not clickable.
    public var onTap: ((Int) -> Void)?

    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.keypadLightTime) private var fixedTime

    /// Creates a drawing.
    ///
    /// - Parameters:
    ///   - lights: The lights to show.
    ///   - lightableKeys: The keys that show per-key lights on the layer, or `nil` for all.
    ///   - connected: Whether the keypad is connected.
    ///   - pressedKey: The key that is down, if any.
    ///   - showsKeyDetails: Whether each key shows its number and whether it has a light of its own.
    ///   - onTap: Called when a key is clicked, or `nil` if keys are not clickable.
    public init(
        lights: DesiredLights,
        lightableKeys: Set<Int>?,
        connected: Bool,
        pressedKey: Int? = nil,
        showsKeyDetails: Bool = false,
        onTap: ((Int) -> Void)? = nil
    ) {
        self.lights = lights
        self.lightableKeys = lightableKeys
        self.connected = connected
        self.pressedKey = pressedKey
        self.showsKeyDetails = showsKeyDetails
        self.onTap = onTap
    }

    /// One cell of the keypad's four-column grid.
    private enum Slot: Hashable {
        case knob
        case joystick
        case badge
        case key(Int)
        case double(Int, Int)
    }

    private static let rows: [[Slot]] = [
        [.knob, .key(0), .key(1), .joystick],
        [.key(2), .key(3), .key(4), .key(5)],
        [.key(6), .key(7), .key(8), .key(9)],
        [.badge, .double(10, 11), .key(12)],
    ]

    /// The key with a frosted, translucent keycap.
    private static let frostedKey = 6

    /// The drawing.
    public var body: some View {
        let state = KeypadLightState(lights: lights, lightableKeys: lightableKeys, connected: connected)
        Group {
            if let fixedTime {
                drawing(state, at: fixedTime)
            } else {
                TimelineView(.animation(minimumInterval: 1 / 24, paused: !state.isAnimated || reduceMotion)) {
                    drawing(state, at: $0.date.timeIntervalSinceReferenceDate)
                }
            }
        }
        .frame(width: KeypadMetrics.outer, height: KeypadMetrics.outer)
        .frame(maxWidth: .infinity)
        .opacity(connected ? 1 : contrast == .increased ? 0.8 : 0.6)
        .accessibilityElement(children: onTap == nil ? .ignore : .contain)
        .accessibilityLabel(
            KeyDescription.summary(lights: lights, lightableKeys: lightableKeys, connected: connected)
        )
    }

    private func drawing(_ state: KeypadLightState, at time: TimeInterval) -> some View {
        ZStack {
            KeypadShell(
                ring: state.ring.map { TwinLight($0, at: time, reduceMotion: reduceMotion) },
                runPosition: state.ring?.runPosition(at: time, reduceMotion: reduceMotion),
                increasedContrast: contrast == .increased,
                darkMenu: colorScheme == .dark
            )
            grid { slot in
                glow(slot, state, at: time)
            }
            grid { slot in
                part(slot, state, at: time)
            }
        }
    }

    private func grid(@ViewBuilder content: @escaping (Slot) -> some View) -> some View {
        VStack(spacing: KeypadMetrics.gap) {
            ForEach(Self.rows.indices, id: \.self) { row in
                HStack(spacing: KeypadMetrics.gap) {
                    ForEach(Self.rows[row], id: \.self) { slot in
                        content(slot).frame(width: width(of: slot), height: KeypadMetrics.key)
                    }
                }
            }
        }
    }

    private func width(of slot: Slot) -> CGFloat {
        if case .double = slot { return KeypadMetrics.key * 2 + KeypadMetrics.gap }
        return KeypadMetrics.key
    }

    private func light(of slot: Slot, _ state: KeypadLightState, at time: TimeInterval) -> TwinLight? {
        let appearance: LightAppearance? =
            switch slot {
            case .key(let key): state.key(key)
            case .double(let first, let second): state.key(first, second)
            case .knob, .joystick, .badge: nil
            }
        return appearance.map { TwinLight($0, at: time, reduceMotion: reduceMotion) }
    }

    /// The light under and around a keycap, drawn below every keycap so that it does not fall on a neighbor.
    @ViewBuilder
    private func glow(_ slot: Slot, _ state: KeypadLightState, at time: TimeInterval) -> some View {
        if let light = light(of: slot, state, at: time) {
            KeyGlow(light: light)
        }
    }

    @ViewBuilder
    private func part(_ slot: Slot, _ state: KeypadLightState, at time: TimeInterval) -> some View {
        switch slot {
        case .knob:
            KnobView()
        case .joystick:
            JoystickView()
        case .badge:
            BadgeView(connected: connected, increasedContrast: contrast == .increased)
        case .key(let key):
            keycap(key, second: nil, label: "\(key)", light: light(of: slot, state, at: time))
        case .double(let first, let second):
            keycap(first, second: second, label: "\(first)–\(second)", light: light(of: slot, state, at: time))
        }
    }

    @ViewBuilder
    private func keycap(_ key: Int, second: Int?, label: String, light: TwinLight?) -> some View {
        let lightable = lightableKeys?.contains(key) ?? true
        let description = KeyDescription.text(
            key: key,
            name: label,
            light: lights.light(forKey: key),
            shown: light?.lightColor,
            lightable: lightable
        )
        let cap = KeycapView(
            light: light,
            frosted: key == Self.frostedKey,
            pressed: connected && pressedKey != nil && (pressedKey == key || pressedKey == second),
            label: showsKeyDetails ? label : nil,
            dashed: showsKeyDetails && !lightable,
            increasedContrast: contrast == .increased
        )
        .help(description)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(description)
        if let onTap {
            Button {
                onTap(key)
            } label: {
                cap
            }
            .buttonStyle(.plain)
        } else {
            cap
        }
    }
}

/// What a key shows, in words, for its tooltip and VoiceOver.
public enum KeyDescription {
    /// Returns a description such as `Key 3, green, breathing`.
    ///
    /// - Parameters:
    ///   - key: The key's index.
    ///   - name: The key's name, such as `3` or `10–11`.
    ///   - light: The key's own light, if one is set.
    ///   - shown: The color that the key shows, if any.
    ///   - lightable: Whether the key can show its own light on the keypad's layer.
    /// - Returns: The description.
    public static func text(key: Int, name: String, light: KeyLight?, shown: LightColor?, lightable: Bool) -> String {
        var parts = ["Key \(name)"]
        if let shown { parts.append(colorName(shown)) } else { parts.append("off") }
        if lightable, shown != nil, let light, light.effect != .solid { parts.append(light.effect.spokenName) }
        if !lightable { parts.append("no light of its own on this layer") }
        return parts.joined(separator: ", ")
    }

    /// Returns one sentence for VoiceOver about the whole keypad, such as
    /// `Keypad lights: ring teal; keys 0 to 5 white; key 6 yellow, breathing; other keys faint white`.
    ///
    /// - Parameters:
    ///   - lights: The app's desired lights.
    ///   - lightableKeys: The keys that show per-key lights on the layer, or `nil` for all.
    ///   - connected: Whether the keypad is connected.
    /// - Returns: The summary.
    public static func summary(lights: DesiredLights, lightableKeys: Set<Int>?, connected: Bool) -> String {
        guard connected else { return "Keypad not connected" }
        let state = KeypadLightState(lights: lights, lightableKeys: lightableKeys, connected: true)
        var parts: [String] = []
        if let ring = state.ring, let effect = lights.zones.ambient?.effect {
            parts.append("ring " + phrase(ring.color, effect))
        }
        var groups: [(phrase: String, keys: [Int])] = []
        var showsZone = false
        for key in 0 ..< KeyInput.count where state.key(key) != nil {
            guard let light = lights.light(forKey: key), lightableKeys?.contains(key) ?? true else {
                showsZone = true
                continue
            }
            let phrase = phrase(light.color, light.effect)
            if let index = groups.firstIndex(where: { $0.phrase == phrase }) {
                groups[index].keys.append(key)
            } else {
                groups.append((phrase, [key]))
            }
        }
        parts += groups.map { "\(names($0.keys)) \($0.phrase)" }
        if showsZone, let zone = lights.zones.keys {
            parts.append((groups.isEmpty ? "keys faint " : "other keys faint ") + phrase(zone.color, zone.effect))
        }
        return parts.isEmpty ? "Keypad lights off" : "Keypad lights: " + parts.joined(separator: "; ")
    }

    /// The nearest common name of a color.
    ///
    /// - Parameter color: The color.
    /// - Returns: A name such as `white`, `red`, or `blue`.
    public static func colorName(_ color: LightColor) -> String {
        let (red, green, blue) = (Double(color.red) / 255, Double(color.green) / 255, Double(color.blue) / 255)
        let maximum = max(red, green, blue)
        let chroma = maximum - min(red, green, blue)
        if maximum < 0.05 { return "off" }
        if chroma / maximum < 0.2 { return "white" }
        var hue: Double
        if maximum == red {
            hue = (green - blue) / chroma
        } else if maximum == green {
            hue = (blue - red) / chroma + 2
        } else {
            hue = (red - green) / chroma + 4
        }
        hue = (hue * 60 + 360).truncatingRemainder(dividingBy: 360)
        switch hue {
        case ..<20, 330...: return "red"
        case ..<45: return "orange"
        case ..<70: return "yellow"
        case ..<165: return "green"
        case ..<195: return "teal"
        case ..<260: return "blue"
        default: return "purple"
        }
    }

    private static func phrase(_ color: LightColor, _ effect: LightEffect) -> String {
        effect == .solid ? colorName(color) : "\(colorName(color)), \(effect.spokenName)"
    }

    /// Names keys, such as `key 6`, `keys 0 to 5`, or `keys 1, 4`.
    private static func names(_ keys: [Int]) -> String {
        guard let first = keys.first, let last = keys.last, keys.count > 1 else {
            return "key \(keys.first ?? 0)"
        }
        if last - first == keys.count - 1 { return "keys \(first) to \(last)" }
        return "keys " + keys.map(String.init).joined(separator: ", ")
    }
}

extension LightEffect {
    /// The effect's name in a sentence.
    fileprivate var spokenName: String {
        self == .shallowBreathing ? "gentle breathing" : name
    }
}

extension Color {
    init(rgb: LightColor) {
        self.init(red: Double(rgb.red) / 255, green: Double(rgb.green) / 255, blue: Double(rgb.blue) / 255)
    }
}
