import CreatorMicro
import Foundation
import SwiftUI

/// The keypad's measurements, in points, from the keycap outward.
enum KeypadMetrics {
    static let key: CGFloat = 36
    static let gap: CGFloat = 5
    static let platePadding: CGFloat = 13
    static let bezel: CGFloat = 11
    static let glowMargin: CGFloat = 22
    static let bodyCorner: CGFloat = 32
    static var plateCorner: CGFloat { bodyCorner - bezel }
    static var grid: CGFloat { key * 4 + gap * 3 }
    static var plate: CGFloat { grid + platePadding * 2 }
    static var body: CGFloat { plate + bezel * 2 }
    static var outer: CGFloat { body + glowMargin * 2 }
}

/// One light at one moment.
struct TwinLight {
    let lightColor: LightColor
    let intensity: Double

    init(_ appearance: LightAppearance, at time: TimeInterval, reduceMotion: Bool) {
        lightColor = appearance.color(at: time, reduceMotion: reduceMotion)
        intensity = appearance.intensity(at: time, reduceMotion: reduceMotion)
    }

    var color: Color { Color(rgb: lightColor) }
}

/// The body, the plate, the light ring, the outer glow, and the plate's screws.
struct KeypadShell: View {
    let ring: TwinLight?
    let runPosition: Double?
    let increasedContrast: Bool
    let darkMenu: Bool

    var body: some View {
        let bodyShape = RoundedRectangle(cornerRadius: KeypadMetrics.bodyCorner, style: .continuous)
        let plateShape = RoundedRectangle(cornerRadius: KeypadMetrics.plateCorner, style: .continuous)
        ZStack {
            if let ring {
                // Two blurs, wide and tight, fade to nothing inside the view's margin.
                bodyShape.fill(ring.color)
                    .frame(width: KeypadMetrics.body, height: KeypadMetrics.body)
                    .blur(radius: 9)
                    .opacity(ring.intensity * (darkMenu ? 0.8 : 0.95))
                bodyShape.fill(ring.color)
                    .frame(width: KeypadMetrics.body + 2, height: KeypadMetrics.body + 2)
                    .blur(radius: 3)
                    .opacity(ring.intensity * 0.5)
            }
            bodyShape
                .fill(.black.opacity(darkMenu ? 0.5 : 0.28))
                .frame(width: KeypadMetrics.body, height: KeypadMetrics.body)
                .offset(y: 2)
                .blur(radius: 3)
            bodyShape
                .fill(LinearGradient(colors: [gray(0.17), gray(0.09)], startPoint: .top, endPoint: .bottom))
                .overlay {
                    bodyShape.strokeBorder(
                        LinearGradient(
                            colors: [.white.opacity(increasedContrast ? 0.7 : 0.26), .white.opacity(0.06)],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: increasedContrast ? 1.5 : 1
                    )
                }
                .frame(width: KeypadMetrics.body, height: KeypadMetrics.body)
            plateShape
                .fill(LinearGradient(colors: [gray(0.055), gray(0.085)], startPoint: .top, endPoint: .bottom))
                .frame(width: KeypadMetrics.plate, height: KeypadMetrics.plate)
            ringView(plateShape)
            screws
        }
    }

    @ViewBuilder
    private func ringView(_ shape: RoundedRectangle) -> some View {
        let size = KeypadMetrics.plate + 2
        shape.strokeBorder(gray(increasedContrast ? 0.42 : 0.24), lineWidth: 1.75).frame(width: size, height: size)
        if let ring {
            shape.strokeBorder(ring.color, lineWidth: 3).frame(width: size, height: size)
                .blur(radius: 2.5)
                .opacity(ring.intensity * 0.55)
            if let runPosition {
                shape.strokeBorder(
                    AngularGradient(
                        colors: [ring.color.opacity(0.15), ring.color.opacity(0.15), ring.color],
                        center: .center,
                        angle: .degrees(runPosition * 360)
                    ),
                    lineWidth: 1.75
                )
                .frame(width: size, height: size)
                .opacity(ring.intensity)
            } else {
                shape.strokeBorder(ring.color, lineWidth: 1.75).frame(width: size, height: size)
                    .opacity(ring.intensity)
            }
        }
    }

    private var screws: some View {
        let distance = KeypadMetrics.plate / 2 - 9
        return ZStack {
            HexScrew().offset(x: -distance, y: -distance)
            HexScrew().offset(x: distance, y: -distance)
            HexScrew().offset(x: -distance, y: distance)
            HexScrew().offset(x: distance, y: distance)
        }
    }
}

/// A small hex screw in a corner of the plate.
private struct HexScrew: View {
    var body: some View {
        ZStack {
            Circle().fill(gray(0.2))
            Hexagon().fill(gray(0.03)).padding(1)
        }
        .frame(width: 6, height: 6)
    }
}

private struct Hexagon: Shape {
    func path(in rect: CGRect) -> Path {
        let radius = min(rect.width, rect.height) / 2
        return Path { path in
            for corner in 0 ..< 6 {
                let angle = Double(corner) * .pi / 3
                let point = CGPoint(x: rect.midX + radius * cos(angle), y: rect.midY + radius * sin(angle))
                if corner == 0 { path.move(to: point) } else { path.addLine(to: point) }
            }
            path.closeSubpath()
        }
    }
}

/// The light under an opaque keycap, which shows around its edge.
struct KeyGlow: View {
    let light: TwinLight

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 9, style: .continuous)
        shape.fill(light.color)
            .padding(-1.5)
            .blur(radius: 2.5)
            .opacity(light.intensity)
    }
}

/// A soft black keycap with a shallow dished center; a frosted one shows its light through the whole cap.
struct KeycapView: View {
    let light: TwinLight?
    let frosted: Bool
    let pressed: Bool
    let label: String?
    let dashed: Bool
    let increasedContrast: Bool

    private static let travel: CGFloat = 1.5

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
        GeometryReader { proxy in
            let dish = RoundedRectangle(
                cornerRadius: min(proxy.size.width, proxy.size.height) * 0.32,
                style: .continuous
            )
            ZStack {
                shape.fill(gray(frosted ? 0.3 : 0.03))
                    .offset(y: Self.travel)
                ZStack {
                    if frosted { frostedFace(shape, dish) } else { opaqueFace(shape, dish) }
                    if dashed {
                        shape.strokeBorder(
                            frosted ? .black.opacity(0.75) : .white.opacity(increasedContrast ? 0.95 : 0.65),
                            style: StrokeStyle(lineWidth: 1, dash: [3, 2])
                        )
                    }
                    if let label {
                        Text(label)
                            .font(.caption2.monospacedDigit().weight(.medium))
                            .foregroundStyle(
                                frosted ? .black.opacity(0.8) : .white.opacity(increasedContrast ? 1 : 0.8)
                            )
                            .padding(.trailing, 4)
                            .padding(.bottom, 2)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    }
                }
                .offset(y: pressed ? Self.travel : 0)
            }
        }
    }

    private func opaqueFace(_ shape: RoundedRectangle, _ dish: RoundedRectangle) -> some View {
        ZStack {
            shape.fill(LinearGradient(colors: [gray(0.235), gray(0.175)], startPoint: .top, endPoint: .bottom))
            dish.fill(LinearGradient(colors: [gray(0.17), gray(0.25)], startPoint: .top, endPoint: .bottom))
                .overlay {
                    dish.strokeBorder(
                        LinearGradient(
                            colors: [.black.opacity(0.45), .white.opacity(0.1)],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 1
                    )
                }
                .padding(4)
            if let light {
                shape.strokeBorder(light.color, lineWidth: 1).opacity(light.intensity * 0.7)
            }
            if increasedContrast {
                shape.strokeBorder(.white.opacity(light == nil ? 0.4 : 0.2), lineWidth: 1)
            }
        }
    }

    private func frostedFace(_ shape: RoundedRectangle, _ dish: RoundedRectangle) -> some View {
        let intensity = light?.intensity ?? 0
        return ZStack {
            shape.fill(gray(0.44 + 0.46 * intensity))
            if let light {
                shape.fill(light.color).opacity(0.3 * intensity + 0.1)
                shape.fill(
                    RadialGradient(
                        colors: [light.color, light.color.opacity(0)],
                        center: .center,
                        startRadius: 1,
                        endRadius: 18
                    )
                )
                .opacity(intensity)
            }
            dish.strokeBorder(.white.opacity(0.28), lineWidth: 1).padding(4)
            shape.strokeBorder(.white.opacity(increasedContrast ? 0.9 : 0.55), lineWidth: 1)
        }
    }
}

/// The round black knob, with its raised indicator bar.
struct KnobView: View {
    var body: some View {
        ZStack {
            Circle()
                .fill(LinearGradient(colors: [gray(0.21), gray(0.07)], startPoint: .top, endPoint: .bottom))
                .overlay { Circle().strokeBorder(.white.opacity(0.14), lineWidth: 0.75) }
                .shadow(color: .black.opacity(0.7), radius: 1.5, y: 1.5)
            Circle()
                .fill(gray(0.12))
                .padding(3)
            RoundedRectangle(cornerRadius: 3.5, style: .continuous)
                .fill(LinearGradient(colors: [gray(0.3), gray(0.17)], startPoint: .top, endPoint: .bottom))
                .overlay {
                    RoundedRectangle(cornerRadius: 3.5, style: .continuous)
                        .strokeBorder(.white.opacity(0.14), lineWidth: 0.5)
                }
                .frame(width: 9, height: 28)
                .shadow(color: .black.opacity(0.7), radius: 1, y: 1)
                .rotationEffect(.degrees(40))
        }
        .padding(1)
    }
}

/// The small joystick: a round black cap on a small square metal base.
struct JoystickView: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [gray(0.62), gray(0.36)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 26, height: 26)
            Circle()
                .fill(RadialGradient(colors: [gray(0.2), gray(0.07)], center: .top, startRadius: 2, endRadius: 22))
                .overlay { Circle().strokeBorder(.white.opacity(0.14), lineWidth: 0.75) }
                .frame(width: 23, height: 23)
                .shadow(color: .black.opacity(0.6), radius: 1.5, y: 1)
        }
    }
}

/// The round badge in the bottom-left slot, and the three status LEDs to its left.
///
/// The LEDs show only whether the keypad is connected;
/// the keypad does not report what its own status LEDs show.
struct BadgeView: View {
    let connected: Bool
    let increasedContrast: Bool

    private static let colors = [
        Color(red: 1, green: 0.88, blue: 0.42), Color(red: 0.78, green: 0.9, blue: 1),
        Color(red: 1, green: 0.88, blue: 0.42),
    ]

    var body: some View {
        HStack(spacing: 3) {
            VStack(spacing: 4) {
                ForEach(Self.colors.indices, id: \.self) { index in
                    Capsule()
                        .fill(connected ? Self.colors[index] : gray(0.24))
                        .frame(width: 4, height: 2.5)
                        .shadow(color: connected ? Self.colors[index].opacity(0.8) : .clear, radius: 1.5)
                }
            }
            ZStack {
                Circle()
                    .fill(gray(0.1))
                    .overlay { Circle().strokeBorder(.white.opacity(increasedContrast ? 0.4 : 0.14), lineWidth: 0.75) }
            }
            .frame(width: 26, height: 26)
        }
    }
}

private func gray(_ white: Double) -> Color {
    Color(white: white)
}
