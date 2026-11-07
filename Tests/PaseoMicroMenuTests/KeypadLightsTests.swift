import CreatorMicro
import PaseoMicroCore
import PaseoMicroMenu
import Testing

@Suite("Keypad lights")
struct KeypadLightsTests {
    private let green = LightColor(packed: 0x00FF00)
    private let teal = LightColor(packed: 0x2DD4BF)
    private let white = LightColor.white

    private func appearance(
        brightness: Double = 1,
        effect: LightEffect = .solid,
        speed: Double = 0.5
    ) -> LightAppearance? {
        LightAppearance(color: green, brightness: brightness, effect: effect, speed: speed)
    }

    private func lights(keys: [KeyLight] = [], zones: ZoneLights = ZoneLights()) -> DesiredLights {
        var lights = DesiredLights()
        lights.set(keys)
        lights.zones = zones
        return lights
    }

    @Test("A light that is off, without brightness, or black does not show")
    func dark() {
        #expect(appearance(effect: .off) == nil)
        #expect(appearance(brightness: 0) == nil)
        #expect(LightAppearance(color: .black, brightness: 1, effect: .solid, speed: 0) == nil)
    }

    @Test("Brightness raises the intensity, and a dim light stays visible")
    func brightness() throws {
        let dim = try #require(appearance(brightness: 0.1))
        let full = try #require(appearance(brightness: 1))
        #expect(dim.intensity > 0.25)
        #expect(dim.intensity < full.intensity)
        #expect(full.intensity == 1)
    }

    @Test("Each effect maps to a motion")
    func motions() {
        #expect(appearance(effect: .solid)?.motion == .steady)
        #expect(appearance(effect: .gradient)?.motion == .steady)
        #expect(appearance(effect: .breathing)?.motion == .pulse(floor: 0.2, period: 4))
        #expect(appearance(effect: .shallowBreathing)?.motion == .pulse(floor: 0.6, period: 4))
        #expect(appearance(effect: .snake)?.motion == .run(period: 4))
        #expect(appearance(effect: .rainbow)?.motion == .cycle(period: 8))
    }

    @Test("A faster effect has a shorter period")
    func speed() {
        #expect(appearance(effect: .breathing, speed: 0)?.motion == .pulse(floor: 0.2, period: 6))
        #expect(appearance(effect: .breathing, speed: 1)?.motion == .pulse(floor: 0.2, period: 2))
    }

    @Test("Breathing pulses between its floor and its full intensity")
    func pulse() throws {
        let light = try #require(appearance(effect: .breathing))
        #expect(abs(light.intensity(at: 0, reduceMotion: false) - 0.2) < 0.001)
        #expect(abs(light.intensity(at: 2, reduceMotion: false) - 1) < 0.001)
        #expect(abs(light.intensity(at: 4, reduceMotion: false) - 0.2) < 0.001)
    }

    @Test("Reduce Motion holds every effect steady", arguments: LightEffect.allCases)
    func reduceMotion(effect: LightEffect) throws {
        guard let light = appearance(effect: effect) else { return }
        for time in [0.0, 1.3, 2, 3.7] {
            #expect(light.intensity(at: time, reduceMotion: true) == light.intensity)
            #expect(light.color(at: time, reduceMotion: true) == green)
            #expect(light.runPosition(at: time, reduceMotion: true) == nil)
        }
    }

    @Test("A rainbow shows without a color of its own, and its hue changes")
    func rainbow() throws {
        let light = try #require(LightAppearance(color: .black, brightness: 1, effect: .rainbow, speed: 0.5))
        #expect(light.color(at: 0, reduceMotion: true) == .white)
        #expect(light.color(at: 0, reduceMotion: false) != light.color(at: 3, reduceMotion: false))
        #expect(light.color(at: 8 * 1000, reduceMotion: false) == light.color(at: 0, reduceMotion: false))
    }

    @Test("A snake's spot runs around the ring")
    func snake() throws {
        let light = try #require(appearance(effect: .snake))
        #expect(light.runPosition(at: 1, reduceMotion: false) == 0.25)
        #expect(appearance(effect: .solid)?.runPosition(at: 1, reduceMotion: false) == nil)
    }

    @Test("A key shows its own light")
    func ownLight() throws {
        let state = KeypadLightState(
            lights: lights(keys: [KeyLight(key: 6, color: green, effect: .breathing)]),
            lightableKeys: nil,
            connected: true
        )
        #expect(state.key(6)?.color == green)
        #expect(state.key(6)?.intensity == 1)
        #expect(state.key(7) == nil)
        #expect(state.isAnimated)
    }

    @Test("A key without its own light shows the keys zone faintly")
    func zone() throws {
        let state = KeypadLightState(
            lights: lights(zones: ZoneLights(keys: ZoneLight(color: white))),
            lightableKeys: nil,
            connected: true
        )
        #expect(state.key(3)?.color == white)
        #expect(state.key(3)?.intensity == KeypadLightState.zoneScale)
    }

    @Test("A key whose light is off stays dark over the keys zone")
    func offOverZone() {
        let state = KeypadLightState(
            lights: lights(keys: [.off(key: 3)], zones: ZoneLights(keys: ZoneLight(color: white))),
            lightableKeys: nil,
            connected: true
        )
        #expect(state.key(3) == nil)
    }

    @Test("A key that cannot show its own light on the layer shows the keys zone")
    func notLightable() {
        let state = KeypadLightState(
            lights: lights(
                keys: [KeyLight(key: 8, color: green), KeyLight(key: 6, color: green)],
                zones: ZoneLights(keys: ZoneLight(color: white))
            ),
            lightableKeys: [6],
            connected: true
        )
        #expect(state.key(6)?.color == green)
        #expect(state.key(8)?.color == white)
    }

    @Test("A double-wide keycap shows its first lit key")
    func doubleWide() {
        let second = KeypadLightState(
            lights: lights(keys: [.off(key: 10), KeyLight(key: 11, color: green)]),
            lightableKeys: nil,
            connected: true
        )
        #expect(second.key(10, 11)?.color == green)
        let both = KeypadLightState(
            lights: lights(keys: [KeyLight(key: 10, color: teal), KeyLight(key: 11, color: green)]),
            lightableKeys: nil,
            connected: true
        )
        #expect(both.key(10, 11)?.color == teal)
    }

    @Test("The ring shows the ambient zone, and is dark when it is off or unset")
    func ring() {
        let lit = KeypadLightState(
            lights: lights(zones: ZoneLights(ambient: ZoneLight(color: teal, effect: .breathing, speed: 0.5))),
            lightableKeys: nil,
            connected: true
        )
        #expect(lit.ring?.color == teal)
        #expect(lit.ring?.motion == .pulse(floor: 0.2, period: 4))
        let off = KeypadLightState(
            lights: lights(zones: ZoneLights(ambient: .off)),
            lightableKeys: nil,
            connected: true
        )
        #expect(off.ring == nil)
        #expect(KeypadLightState(lights: lights(), lightableKeys: nil, connected: true).ring == nil)
    }

    @Test("A keypad that is not connected shows no lights")
    func disconnected() {
        let state = KeypadLightState(
            lights: lights(
                keys: [KeyLight(key: 6, color: green, effect: .breathing)],
                zones: ZoneLights(keys: ZoneLight(color: white), ambient: ZoneLight(color: teal))
            ),
            lightableKeys: nil,
            connected: false
        )
        #expect(state.ring == nil)
        #expect(state.key(6) == nil)
        #expect(state.key(0) == nil)
        #expect(!state.isAnimated)
    }

    @Test("VoiceOver hears one summary of the keypad")
    func summary() {
        var desired = lights(
            keys: (0 ..< 6).map { KeyLight(key: $0, color: white, brightness: 0.2) } + [
                KeyLight(key: 6, color: LightColor(packed: 0xFFC800), effect: .breathing)
            ],
            zones: ZoneLights(
                keys: ZoneLight(color: white, brightness: 0.1),
                ambient: ZoneLight(color: teal)
            )
        )
        #expect(
            KeyDescription.summary(lights: desired, lightableKeys: nil, connected: true)
                == "Keypad lights: ring teal; keys 1 to 6 white; key 7 yellow, breathing; other keys faint white"
        )
        #expect(KeyDescription.summary(lights: desired, lightableKeys: nil, connected: false) == "Keypad not connected")
        #expect(
            KeyDescription.summary(lights: desired, lightableKeys: [], connected: true)
                == "Keypad lights: ring teal; keys faint white"
        )
        desired = lights()
        #expect(KeyDescription.summary(lights: desired, lightableKeys: nil, connected: true) == "Keypad lights off")
    }
}
