import PaseoMicroCore
import SwiftUI

/// The radial menu: eight slots in a ring, clockwise from up, around the name of the target agent.
///
/// The highlighted slot is larger; it fills with its color once a release would pick it.
/// A slot that cannot act is dimmed.
struct RadialMenuView: View {
    /// The width and height of the menu, and of its panel.
    static let side: CGFloat = 360

    private static let ringRadius: CGFloat = 122
    private static let slotDiameter: CGFloat = 80
    private static let centerDiameter: CGFloat = 132

    let presentation: RadialMenuPresentation

    var body: some View {
        ZStack {
            Circle()
                .fill(Color.black.opacity(0.72))
                .overlay(Circle().strokeBorder(Color.white.opacity(0.15), lineWidth: 1))
                .padding(4)
            ForEach(Array(presentation.menu.slots.enumerated()), id: \.offset) { index, slot in
                SlotView(
                    slot: slot,
                    highlighted: presentation.highlighted == index,
                    armed: presentation.highlighted == index && presentation.isArmed && slot.enabled,
                    diameter: Self.slotDiameter
                )
                .offset(Self.offset(of: index))
            }
            center
        }
        .frame(width: Self.side, height: Self.side)
        .environment(\.colorScheme, .dark)
        .animation(.easeOut(duration: 0.1), value: presentation.highlighted)
        .animation(.easeOut(duration: 0.1), value: presentation.isArmed)
    }

    private var center: some View {
        VStack(spacing: 2) {
            Text(presentation.menu.target == nil ? "No agent" : "Acts on")
                .font(.caption2)
                .foregroundStyle(.secondary)
            if let target = presentation.menu.target {
                Text(target)
                    .font(.system(size: 13, weight: .semibold))
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            }
        }
        .padding(12)
        .frame(width: Self.centerDiameter, height: Self.centerDiameter)
        .background(Circle().fill(Color.white.opacity(0.06)))
    }

    /// Slot 0 is straight up; each next slot is 45° further clockwise.
    private static func offset(of index: Int) -> CGSize {
        let angle = Double(index) * 2 * .pi / Double(RadialMenu.slotCount)
        return CGSize(width: ringRadius * sin(angle), height: -ringRadius * cos(angle))
    }
}

private struct SlotView: View {
    let slot: RadialMenuSlot
    let highlighted: Bool
    let armed: Bool
    let diameter: CGFloat

    private var color: Color {
        slot.rgb.map { Color(red: $0.red, green: $0.green, blue: $0.blue) } ?? .white
    }

    var body: some View {
        VStack(spacing: 3) {
            Image(systemName: slot.icon)
                .font(.system(size: 24, weight: .medium))
            Text(slot.label)
                .font(.system(size: 11, weight: .medium))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .foregroundStyle(armed ? Color.black : color)
        .padding(6)
        .frame(width: diameter, height: diameter)
        .background(Circle().fill(armed ? color : color.opacity(highlighted ? 0.3 : 0.1)))
        .overlay(Circle().strokeBorder(color.opacity(highlighted ? 0.9 : 0.25), lineWidth: highlighted ? 2 : 1))
        .scaleEffect(highlighted ? 1.2 : 1)
        .opacity(slot.enabled ? 1 : 0.3)
        .accessibilityElement(children: .combine)
    }
}
