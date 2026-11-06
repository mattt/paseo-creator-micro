import CreatorMicro
import PaseoMicroCore
import SwiftUI

/// A drawing of the keypad's 13 keys with their current lights,
/// on the keypad's four-column grid.
///
/// The top row's two keys sit in the middle columns.
/// The bottom row leaves the first column empty, where the keypad has its logo,
/// and draws keys 10 and 11 as one double-wide key, as under a double-wide keycap.
/// With its details showing, each key has its number,
/// and a key that cannot show its own light on the keypad's layer has a dashed outline.
public struct KeypadView: View {
    /// The lights to show.
    public var lights: DesiredLights
    /// The keys that show per-key lights on the keypad's layer,
    /// or `nil` to draw every key as able to (as when the layer is unknown).
    public var lightableKeys: Set<Int>?
    /// Whether the keypad is connected; keys are dimmed when it is not.
    public var connected: Bool
    /// Whether each key shows its number and whether it has a light of its own.
    public var showsKeyDetails: Bool
    /// Called when a key is clicked, or `nil` if keys are not clickable.
    public var onTap: ((Int) -> Void)?

    @Environment(\.colorSchemeContrast) private var contrast

    /// Creates a drawing.
    ///
    /// - Parameters:
    ///   - lights: The lights to show.
    ///   - lightableKeys: The keys that show per-key lights on the layer, or `nil` for all.
    ///   - connected: Whether the keypad is connected.
    ///   - showsKeyDetails: Whether each key shows its number and whether it has a light of its own.
    ///   - onTap: Called when a key is clicked, or `nil` if keys are not clickable.
    public init(
        lights: DesiredLights,
        lightableKeys: Set<Int>?,
        connected: Bool,
        showsKeyDetails: Bool = false,
        onTap: ((Int) -> Void)? = nil
    ) {
        self.lights = lights
        self.lightableKeys = lightableKeys
        self.connected = connected
        self.showsKeyDetails = showsKeyDetails
        self.onTap = onTap
    }

    /// One grid cell: nothing, one key, or a key that spans two columns.
    private enum Slot: Hashable {
        case empty
        case key(Int)
        case double(Int, Int)
    }

    private static let rows: [[Slot]] = [
        [.empty, .key(0), .key(1), .empty],
        [.key(2), .key(3), .key(4), .key(5)],
        [.key(6), .key(7), .key(8), .key(9)],
        [.empty, .double(10, 11), .key(12)],
    ]

    private static let keySize: CGFloat = 40
    private static let spacing: CGFloat = 6

    /// The drawing.
    public var body: some View {
        VStack(spacing: Self.spacing) {
            ForEach(Self.rows.indices, id: \.self) { row in
                HStack(spacing: Self.spacing) {
                    ForEach(Self.rows[row].indices, id: \.self) { column in
                        slotView(Self.rows[row][column])
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity)
        .background(.fill.quinary, in: RoundedRectangle(cornerRadius: 10))
        .opacity(connected || contrast == .increased ? 1 : 0.5)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Keypad lights")
    }

    @ViewBuilder
    private func slotView(_ slot: Slot) -> some View {
        switch slot {
        case .empty:
            Color.clear.frame(width: Self.keySize, height: Self.keySize).accessibilityHidden(true)
        case .key(let key):
            keyView(key, label: "\(key)", columns: 1)
        case .double(let first, let second):
            keyView(first, label: "\(first)–\(second)", columns: 2)
        }
    }

    @ViewBuilder
    private func keyView(_ key: Int, label: String, columns: Int) -> some View {
        let lightable = lightableKeys?.contains(key) ?? true
        let shown = lightable ? lights.displayedColor(forKey: key) : lights.zoneColor
        let border = StrokeStyle(
            lineWidth: contrast == .increased ? 1.5 : 1,
            dash: lightable || !showsKeyDetails ? [] : [3, 2]
        )
        let shape = RoundedRectangle(cornerRadius: 6)
        let width = Self.keySize * CGFloat(columns) + Self.spacing * CGFloat(columns - 1)
        let description = KeyDescription.text(
            key: key,
            name: label,
            light: lights.light(forKey: key),
            shown: shown?.color,
            lightable: lightable
        )
        let face = shape.fill(
            shown.map { AnyShapeStyle(Color(rgb: $0.color).opacity(0.25 + 0.75 * $0.brightness)) }
                ?? AnyShapeStyle(.fill.tertiary)
        )
        .overlay(shape.strokeBorder(contrast == .increased ? .primary : .tertiary, style: border))
        .overlay(alignment: .bottomTrailing) {
            if showsKeyDetails {
                Text(label).font(.caption2.monospacedDigit()).foregroundStyle(.secondary).padding(3)
            }
        }
        .frame(width: width, height: Self.keySize)
        .help(description)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(description)
        if let onTap {
            Button {
                onTap(key)
            } label: {
                face
            }
            .buttonStyle(.plain)
        } else {
            face
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
        if lightable, shown != nil, let light, light.effect != .solid { parts.append(light.effect.name) }
        if !lightable { parts.append("no light of its own on this layer") }
        return parts.joined(separator: ", ")
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
        case ..<260: return "blue"
        default: return "purple"
        }
    }
}

extension DesiredLights {
    /// The key backlight zone's color, which a key without a light of its own shows.
    fileprivate var zoneColor: (color: LightColor, brightness: Double)? {
        guard let zone = zones.keys, zone.effect != .off else { return nil }
        return (zone.color, zone.brightness)
    }
}

extension Color {
    init(rgb: LightColor) {
        self.init(red: Double(rgb.red) / 255, green: Double(rgb.green) / 255, blue: Double(rgb.blue) / 255)
    }
}
