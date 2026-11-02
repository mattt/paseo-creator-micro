import CreatorMicro
import PaseoMicroCore
import SwiftUI

/// A drawing of the keypad's 13 keys with their current lights,
/// on the keypad's four-column grid.
///
/// The top row's two keys sit in the middle columns.
/// The bottom row leaves the first column empty, where the keypad has its logo,
/// and draws keys 10 and 11 as one double-wide key, as under a double-wide keycap.
/// A key that cannot show its own light on the keypad's layer has a dashed outline.
struct KeypadView: View {
    /// The lights to show.
    var lights: DesiredLights
    /// The keys that show per-key lights on the keypad's layer,
    /// or `nil` to draw every key as able to (as when the layer is unknown).
    var lightableKeys: Set<Int>?
    /// Whether the keypad is connected; keys are dimmed when it is not.
    var connected: Bool
    /// Called when a key is clicked, or `nil` if keys are not clickable.
    var onTap: ((Int) -> Void)?

    /// One grid cell: nothing, one key, or a key that spans two columns.
    enum Slot: Hashable {
        case empty
        case key(Int)
        case double(Int, Int)
    }

    static let rows: [[Slot]] = [
        [.empty, .key(0), .key(1), .empty],
        [.key(2), .key(3), .key(4), .key(5)],
        [.key(6), .key(7), .key(8), .key(9)],
        [.empty, .double(10, 11), .key(12)],
    ]

    private static let keySize: CGFloat = 40
    private static let spacing: CGFloat = 6

    var body: some View {
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
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.06)))
        .opacity(connected ? 1 : 0.5)
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
        let border = StrokeStyle(lineWidth: 1, dash: lightable ? [] : [3, 2])
        let fill =
            shown.map { Color(rgb: $0.color).opacity(0.25 + 0.75 * $0.brightness) } ?? Color.secondary.opacity(0.15)
        let shape = RoundedRectangle(cornerRadius: 6)
        let width = Self.keySize * CGFloat(columns) + Self.spacing * CGFloat(columns - 1)
        let face = shape.fill(fill)
            .overlay(shape.strokeBorder(Color.primary.opacity(0.25), style: border))
            .overlay(alignment: .bottomTrailing) {
                Text(label).font(.system(size: 8).monospacedDigit()).foregroundStyle(.secondary).padding(3)
            }
            .frame(width: width, height: Self.keySize)
            .help(help(for: key))
            .accessibilityLabel(help(for: key))
        if let onTap {
            Button {
                onTap(key)
            } label: {
                face
            }.buttonStyle(.plain)
        } else {
            face
        }
    }

    private func help(for key: Int) -> String {
        if let lightableKeys, !lightableKeys.contains(key) {
            return
                "Key \(key): no light of its own on this layer, which binds it to a code other than AG\(key < 10 ? "0" : "")\(key)"
        }
        if let light = lights.light(forKey: key) {
            return "Key \(key): \(light.color.hex), \(light.effect.name)"
        }
        return "Key \(key): no light of its own"
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
