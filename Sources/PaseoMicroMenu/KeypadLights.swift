import CreatorMicro
import Foundation
import PaseoMicroCore

/// How one light looks on the keypad's drawing.
///
/// The firmware does not report its animation's phase,
/// so an animated light shows the same effect as the keypad, not the same moment of it.
public struct LightAppearance: Hashable, Sendable {
    /// How a light changes over time.
    public enum Motion: Hashable, Sendable {
        /// The light does not change.
        case steady
        /// The intensity rises and falls between a fraction of its full value and its full value.
        case pulse(floor: Double, period: TimeInterval)
        /// A bright spot runs around the light ring; a key stays steady.
        case run(period: TimeInterval)
        /// The color cycles through the hues.
        case cycle(period: TimeInterval)
    }

    /// The light's color.
    public var color: LightColor
    /// How strongly the light shows at its fullest, from 0 to 1.
    public var intensity: Double
    /// How the light changes over time.
    public var motion: Motion

    /// Creates an appearance, if the light shows at all.
    ///
    /// The `gradient` effect has no firmware colors to read, so it shows as a steady color.
    ///
    /// - Parameters:
    ///   - color: The light's color.
    ///   - brightness: The light's brightness, from 0 to 1.
    ///   - effect: The light's animation.
    ///   - speed: The animation's speed, from 0 to 1.
    ///   - scale: A factor for the intensity.
    /// - Returns: The appearance, or `nil` for a light that is off, has no brightness, or is black.
    public init?(color: LightColor, brightness: Double, effect: LightEffect, speed: Double, scale: Double = 1) {
        guard effect != .off, brightness > 0, effect == .rainbow || color != .black else { return nil }
        self.color = color == .black ? .white : color
        // LEDs look bright at low settings, so that a dim light stays visible on the drawing.
        intensity = (0.25 + 0.75 * min(brightness, 1)) * scale
        let period = 6 - 4 * min(max(speed, 0), 1)
        switch effect {
        case .breathing: motion = .pulse(floor: 0.2, period: period)
        case .shallowBreathing: motion = .pulse(floor: 0.6, period: period)
        case .snake: motion = .run(period: period)
        case .rainbow: motion = .cycle(period: period * 2)
        case .off, .solid, .gradient: motion = .steady
        }
    }

    /// Whether the light changes over time.
    public var isAnimated: Bool {
        motion != .steady
    }

    /// Returns how strongly the light shows at a moment.
    ///
    /// - Parameters:
    ///   - time: The moment, in seconds.
    ///   - reduceMotion: Whether to hold the light steady.
    /// - Returns: The intensity, from 0 to 1.
    public func intensity(at time: TimeInterval, reduceMotion: Bool) -> Double {
        guard !reduceMotion, case .pulse(let floor, let period) = motion else { return intensity }
        let phase = (1 - cos(2 * .pi * time / period)) / 2
        return intensity * (floor + (1 - floor) * phase)
    }

    /// Returns the light's color at a moment.
    ///
    /// - Parameters:
    ///   - time: The moment, in seconds.
    ///   - reduceMotion: Whether to hold the light steady.
    /// - Returns: The color.
    public func color(at time: TimeInterval, reduceMotion: Bool) -> LightColor {
        guard !reduceMotion, case .cycle(let period) = motion else { return color }
        return LightColor(hue: (time / period).truncatingRemainder(dividingBy: 1))
    }

    /// Returns where a running light's bright spot is at a moment.
    ///
    /// - Parameters:
    ///   - time: The moment, in seconds.
    ///   - reduceMotion: Whether to hold the light steady.
    /// - Returns: The fraction of a turn, from 0 to 1, or `nil` if the light has no running spot.
    public func runPosition(at time: TimeInterval, reduceMotion: Bool) -> Double? {
        guard !reduceMotion, case .run(let period) = motion else { return nil }
        return (time / period).truncatingRemainder(dividingBy: 1)
    }
}

/// What each part of the keypad's drawing shows, from the app's desired lights.
public struct KeypadLightState: Hashable, Sendable {
    /// The factor for the intensity of a key that shows the `keys` zone.
    public static let zoneScale = 0.45

    /// The light ring and the outer glow, or `nil` when they are dark.
    public var ring: LightAppearance?

    private var keys: [Int: LightAppearance] = [:]

    /// Creates the state.
    ///
    /// A keypad that is not connected shows nothing, whatever lights the app keeps for it.
    ///
    /// - Parameters:
    ///   - lights: The app's desired lights.
    ///   - lightableKeys: The keys that show per-key lights on the keypad's layer, or `nil` for all.
    ///   - connected: Whether the keypad is connected.
    public init(lights: DesiredLights, lightableKeys: Set<Int>?, connected: Bool) {
        guard connected else { return }
        ring = lights.zones.ambient.flatMap { zone in
            LightAppearance(color: zone.color, brightness: zone.brightness, effect: zone.effect, speed: zone.speed)
        }
        let zone = lights.zones.keys.flatMap { zone in
            LightAppearance(
                color: zone.color,
                brightness: zone.brightness,
                effect: zone.effect,
                speed: zone.speed,
                scale: Self.zoneScale
            )
        }
        for key in 0 ..< KeyInput.count {
            if let light = lights.light(forKey: key), lightableKeys?.contains(key) ?? true {
                keys[key] = LightAppearance(
                    color: light.color,
                    brightness: light.brightness,
                    effect: light.effect,
                    speed: light.speed
                )
            } else {
                keys[key] = zone
            }
        }
    }

    /// Returns what a key shows.
    ///
    /// - Parameter key: The key's index.
    /// - Returns: The appearance, or `nil` when the key is dark.
    public func key(_ key: Int) -> LightAppearance? {
        keys[key]
    }

    /// Returns what a double-wide keycap over two keys shows: the first lit key's light.
    ///
    /// - Parameters:
    ///   - first: The index of the keycap's first key.
    ///   - second: The index of the keycap's second key.
    /// - Returns: The appearance, or `nil` when both keys are dark.
    public func key(_ first: Int, _ second: Int) -> LightAppearance? {
        keys[first] ?? keys[second]
    }

    /// Whether any part of the drawing changes over time.
    public var isAnimated: Bool {
        ring?.isAnimated == true || keys.values.contains(where: \.isAnimated)
    }
}

extension LightColor {
    /// Creates a fully saturated, fully bright color.
    ///
    /// - Parameter hue: The hue, from 0 to 1.
    fileprivate init(hue: Double) {
        let sector = max(hue, 0) * 6
        let rise = sector.truncatingRemainder(dividingBy: 1)
        let (red, green, blue): (Double, Double, Double) =
            switch Int(sector) % 6 {
            case 0: (1, rise, 0)
            case 1: (1 - rise, 1, 0)
            case 2: (0, 1, rise)
            case 3: (0, 1 - rise, 1)
            case 4: (rise, 0, 1)
            default: (1, 0, 1 - rise)
            }
        self.init(red: UInt8(red * 255), green: UInt8(green * 255), blue: UInt8(blue * 255))
    }
}
