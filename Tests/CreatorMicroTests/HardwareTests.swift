import CreatorMicro
import Foundation
import Testing

/// Tests against a real keypad. Set `PASEO_MICRO_HARDWARE=1` to run them.
///
/// They send only read-only calls and lighting previews; they never write the keypad's files.
@Suite(
    "Hardware",
    .enabled(if: ProcessInfo.processInfo.environment["PASEO_MICRO_HARDWARE"] == "1"),
    .serialized
)
struct HardwareTests {
    private func connectedClient() async throws -> KeypadClient {
        let client = KeypadClient(transport: HIDTransport())
        let events = await client.events()
        await client.start()
        for try await event in events {
            if case .connected = event { break }
        }
        return client
    }

    @Test("Reads the firmware version and status from the keypad")
    func versionAndStatus() async throws {
        let client = try await connectedClient()
        defer { Task { await client.stop() } }
        let device = try #require(await client.device)
        #expect(HIDTransport.productIDs.contains(device.productID))
        let version = try await client.version()
        #expect(!version.isEmpty)
        let status = try await client.status()
        #expect(status.layer != nil)
        #expect(status.battery != nil)
        print("Keypad: \(device), firmware \(version), \(status)")
    }

    @Test("Sends lighting previews that the keypad accepts")
    func lighting() async throws {
        let client = try await connectedClient()
        defer { Task { await client.stop() } }
        try await client.setKeyLights([KeyLight(key: 0, color: LightColor(packed: 0x2D7DFF), effect: .solid)])
        try await client.setZones(
            ZoneLights(
                keys: ZoneLight(color: .white, brightness: 0.3),
                ambient: ZoneLight(color: LightColor(packed: 0x2D7DFF), brightness: 0.5)
            )
        )
    }
}
