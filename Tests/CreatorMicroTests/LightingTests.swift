import CreatorMicro
import Foundation
import Testing

@Suite("Lighting")
struct LightingTests {
    @Test("Colors parse from hex and pack as 0xRRGGBB")
    func colors() throws {
        let color = try #require(LightColor(hex: "#FF2D2D"))
        #expect(color.packed == 0xFF2D2D)
        #expect(color.hex == "#FF2D2D")
        #expect(LightColor(hex: "0a0b0c")?.packed == 0x0A0B0C)
        #expect(LightColor(hex: "#abc")?.hex == "#AABBCC")
        #expect(LightColor(packed: 0x0000FF).hex == "#0000FF")
        for bad in ["", "#12345", "#GGGGGG", "#1234567", "red"] {
            #expect(LightColor(hex: bad) == nil)
        }
    }

    @Test("Effects have firmware indexes and bridge names")
    func effects() {
        #expect(LightEffect.allCases.map(\.rawValue) == Array(0 ... 6))
        #expect(
            LightEffect.allCases.map(\.name) == [
                "off", "solid", "snake", "rainbow", "breathing", "gradient", "shallowBreathing",
            ]
        )
        #expect(LightEffect(name: "breathing") == .breathing)
        #expect(LightEffect(name: "breath") == nil)
    }

    @Test("Key lights encode as v.oai.thstatus entries")
    func keyLightEncoding() {
        let light = KeyLight(key: 2, color: LightColor(packed: 0xFF2D2D), brightness: 1, effect: .breathing, speed: 0.5)
        #expect(light.firmwareEntry.jsonString == #"{"b":1,"c":16723245,"e":4,"id":2,"s":0.5}"#)
        #expect(KeyLight.firmwareParams([light]).arrayValue?.count == 1)
        #expect(KeyLight(firmwareEntry: light.firmwareEntry) == light)
    }

    @Test("Brightness and speed clamp to 0...1")
    func clamping() {
        let light = KeyLight(key: 0, color: .white, brightness: 4, speed: -1)
        #expect(light.brightness == 1)
        #expect(light.speed == 0)
        #expect(ZoneLight(color: .white, brightness: .nan).brightness == 0)
    }

    @Test("Zones encode as v.oai.rgbcfg, with an unset zone off")
    func zones() {
        let zones = ZoneLights(ambient: ZoneLight(color: LightColor(packed: 0x0000FF), effect: .solid, brightness: 0.5))
        #expect(
            zones.firmwareParams.jsonString
                == #"{"ambient":{"b":0.5,"c":255,"e":1,"m":1,"s":0},"keys":{"b":0,"c":0,"e":0,"m":1,"s":0}}"#
        )
        #expect(ZoneLight(firmwareEntry: zones.firmwareParams["ambient"]!) == zones.ambient)
    }

    @Test("Lights decode from the bridge's form with defaults")
    func bridgeForm() throws {
        let json = ##"{"key":0,"color":"#FF2D2D","effect":"breathing"}"##
        let light = try JSONDecoder().decode(KeyLight.self, from: Data(json.utf8))
        #expect(
            light
                == KeyLight(key: 0, color: LightColor(packed: 0xFF2D2D), brightness: 1, effect: .breathing, speed: 0.5)
        )
        let zone = try JSONDecoder().decode(
            ZoneLight.self,
            from: Data(##"{"color":"#FFFFFF","effect":"solid","brightness":0.3}"##.utf8)
        )
        #expect(zone == ZoneLight(color: .white, effect: .solid, brightness: 0.3))
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(KeyLight.self, from: Data(#"{"key":0,"color":"blue"}"#.utf8))
        }
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(
                KeyLight.self,
                from: Data(##"{"key":0,"color":"#0000FF","effect":"sparkle"}"##.utf8)
            )
        }
    }

    @Test("Lights encode colors as hex and effects as names")
    func encoding() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data = try encoder.encode(KeyLight(key: 1, color: LightColor(packed: 0x00FF00), effect: .shallowBreathing))
        #expect(
            String(decoding: data, as: UTF8.self)
                == ##"{"brightness":1,"color":"#00FF00","effect":"shallowBreathing","key":1,"speed":0.5}"##
        )
    }
}
