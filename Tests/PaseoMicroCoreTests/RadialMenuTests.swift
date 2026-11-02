import AppKit
import CoreGraphics
import CreatorMicro
import Foundation
@testable import PaseoMicroCore
import Testing

/// The default menu that the plugin sends, with every slot enabled.
func sampleMenu(enabled: [Bool] = Array(repeating: true, count: 8), target: String? = "Fix the build") -> RadialMenu {
    let slots: [(String, String, String?)] = [
        ("checkmark.circle", "Approve", "#34C759"),
        ("testtube.2", "Test", nil),
        ("play.circle", "Continue", nil),
        ("arrow.triangle.branch", "Commit", nil),
        ("xmark.circle", "Deny", "#FF3B30"),
        ("magnifyingglass", "Review", nil),
        ("stop.circle", "Stop", "#FF9500"),
        ("list.bullet", "Summary", nil),
    ]
    return RadialMenu(
        slots: zip(slots, enabled).map { slot, enabled in
            RadialMenuSlot(icon: slot.0, label: slot.1, color: slot.2, enabled: enabled)
        },
        target: target
    )
}

/// A position of the stick: angle as a fraction of a turn counterclockwise from east.
private func stick(_ angle: Double, _ distance: Double) -> JoystickInput {
    JoystickInput(angle: angle, distance: distance, sector: Int(angle * 8) % 8)
}

private let rest = JoystickInput(angle: 0, distance: 0, sector: -1)

@Suite("Radial selector")
struct RadialSelectorTests {
    /// Feeds positions 20 milliseconds apart, as the firmware streams them, and returns the outcomes.
    private func feed(
        _ selector: inout RadialSelector,
        _ positions: [JoystickInput],
        every interval: Duration = .milliseconds(20),
        from start: ContinuousClock.Instant
    ) -> [RadialSelector.Outcome] {
        var outcomes: [RadialSelector.Outcome] = []
        for (index, position) in positions.enumerated() {
            if let outcome = selector.update(position, at: start + interval * index) { outcomes.append(outcome) }
        }
        return outcomes
    }

    static let angles: [(Double, Int)] = [
        (0.25, 0), (0.125, 1), (0.0, 2), (0.875, 3), (0.75, 4), (0.625, 5), (0.5, 6), (0.375, 7),
        // The capture of 2026-10-28: south 0.755, west 0.494, north 0.244, east 0.006.
        (0.755, 4), (0.494, 6), (0.244, 0), (0.006, 2),
        // Each sector spans 22.5° on either side of its direction.
        (0.31, 0), (0.19, 0), (0.32, 7), (0.18, 1),
    ]

    @Test("Maps each angle to the nearest of eight slots, clockwise from up", arguments: angles)
    func slots(angle: Double, slot: Int) {
        #expect(RadialSelector.slot(forAngle: angle) == slot)
    }

    @Test("Wraps around at east", arguments: [0.0, 0.01, 0.06, 0.94, 0.99, 1.0, -0.01, 1.01])
    func wrapsAtEast(angle: Double) {
        #expect(RadialSelector.slot(forAngle: angle) == 2)
    }

    @Test("Opens once the stick passes the open distance, and highlights the slot of its angle")
    func opens() {
        var selector = RadialSelector()
        let start = ContinuousClock.now
        #expect(selector.update(stick(0.25, 0.3), at: start) == nil)
        #expect(!selector.isOpen)
        #expect(selector.update(stick(0.25, 0.49), at: start) == nil)
        #expect(!selector.isOpen)
        #expect(selector.update(stick(0.25, 0.5), at: start) == nil)
        #expect(selector.isOpen)
        #expect(selector.highlighted == 0)
        #expect(!selector.isArmed)
        _ = selector.update(stick(0.25, 0.8), at: start)
        #expect(selector.isArmed)
    }

    @Test("Does not open at rest, whatever the distance")
    func restDoesNotOpen() {
        var selector = RadialSelector()
        #expect(selector.update(JoystickInput(angle: 0.25, distance: 0.9, sector: -1), at: .now) == nil)
        #expect(!selector.isOpen)
    }

    @Test("Highlights each slot as the stick sweeps around, and wraps through east")
    func sweep() {
        var selector = RadialSelector()
        let start = ContinuousClock.now
        var seen: [Int?] = []
        for step in 0 ..< 16 {
            // Clockwise from up in steps of half a sector.
            let angle = 0.25 - Double(step) / 16
            _ = selector.update(stick((angle + 1).truncatingRemainder(dividingBy: 1), 1), at: start)
            seen.append(selector.highlighted)
        }
        #expect(seen == [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 0])
        _ = selector.update(stick(0.99, 1), at: start)
        #expect(selector.highlighted == 2)
        _ = selector.update(stick(0.01, 1), at: start)
        #expect(selector.highlighted == 2)
    }

    @Test("Picks the armed slot when the stick springs back within a few samples")
    func picksOnFastRelease() {
        var selector = RadialSelector()
        let outcomes = feed(
            &selector,
            [stick(0.0, 0.6), stick(0.0, 1), stick(0.0, 1), stick(0.0, 0.4), stick(0.3, 0.1), rest],
            from: .now
        )
        #expect(outcomes == [.picked(2)])
        #expect(!selector.isOpen)
        #expect(selector.highlighted == nil)
    }

    @Test("Picks after the stick is held still for a long time, then released")
    func picksAfterHold() {
        var selector = RadialSelector()
        let start = ContinuousClock.now
        #expect(selector.update(stick(0.125, 1), at: start) == nil)
        #expect(selector.update(stick(0.125, 0.4), at: start + .seconds(5)) == nil)
        #expect(selector.update(rest, at: start + .seconds(5) + .milliseconds(40)) == .picked(1))
    }

    @Test("Keeps the armed slot through the noisy angles near the center during a release")
    func ignoresNoiseNearCenter() {
        var selector = RadialSelector()
        let outcomes = feed(&selector, [stick(0.75, 1), stick(0.6, 0.3), stick(0.1, 0.2), rest], from: .now)
        #expect(outcomes == [.picked(4)])
    }

    @Test("Cancels when the stick drifts back slowly through the center")
    func cancelsOnSlowReturn() {
        var selector = RadialSelector()
        let positions =
            [stick(0.25, 1), stick(0.25, 0.9), stick(0.25, 0.8)]
            + stride(from: 0.7, through: 0.2, by: -0.05).map { stick(0.25, $0) } + [rest]
        let outcomes = feed(&selector, positions, every: .milliseconds(40), from: .now)
        #expect(outcomes == [.cancelled])
        #expect(!selector.isOpen)
    }

    @Test("Cancels a release from a push that never reached the select distance")
    func cancelsOnLowDistance() {
        var selector = RadialSelector()
        let outcomes = feed(&selector, [stick(0.25, 0.55), stick(0.25, 0.7), stick(0.25, 0.3), rest], from: .now)
        #expect(outcomes == [.cancelled])
    }

    @Test("Arms again after a slow drift when the stick goes back out")
    func armsAgain() {
        var selector = RadialSelector()
        let start = ContinuousClock.now
        _ = selector.update(stick(0.25, 1), at: start)
        _ = selector.update(stick(0.25, 0.6), at: start + .milliseconds(10))
        _ = selector.update(stick(0.5, 0.6), at: start + .milliseconds(400))
        _ = selector.update(stick(0.5, 1), at: start + .milliseconds(800))
        #expect(selector.update(rest, at: start + .milliseconds(820)) == .picked(6))
    }

    @Test("Opens again for the next push after an outcome")
    func reopens() {
        var selector = RadialSelector()
        let start = ContinuousClock.now
        #expect(feed(&selector, [stick(0.25, 1), rest], from: start) == [.picked(0)])
        #expect(feed(&selector, [stick(0.75, 1), rest], from: start + .seconds(1)) == [.picked(4)])
    }

    @Test("A reset closes the menu without an outcome")
    func reset() {
        var selector = RadialSelector()
        _ = selector.update(stick(0.25, 1), at: .now)
        selector.reset()
        #expect(!selector.isOpen)
        #expect(selector.update(rest, at: .now) == nil)
    }

    @Test("A dismissal closes the menu, and the stick's return neither picks nor opens it again")
    func dismiss() {
        var selector = RadialSelector()
        let start = ContinuousClock.now
        let closedDismiss = selector.dismiss()
        #expect(!closedDismiss)
        #expect(feed(&selector, [stick(0.25, 1)], from: start).isEmpty)
        let openDismiss = selector.dismiss()
        #expect(openDismiss)
        #expect(!selector.isOpen)
        #expect(selector.highlighted == nil)
        #expect(selector.isDismissed)
        // The stick is still out, moves to another slot, and springs back: nothing opens or picks.
        #expect(feed(&selector, [stick(0.25, 1), stick(0.75, 1), stick(0.75, 0.3), rest], from: start).isEmpty)
        #expect(!selector.isOpen)
        #expect(!selector.isDismissed)
        // The next push opens and picks as usual.
        #expect(feed(&selector, [stick(0.75, 1), rest], from: start + .seconds(1)) == [.picked(4)])
    }

    @Test("The tuning's thresholds increase from rest to select")
    func tuningOrder() {
        let tuning = RadialSelector.Tuning.standard
        #expect(tuning.restDistance < tuning.openDistance)
        #expect(tuning.openDistance < tuning.selectDistance)
        #expect(tuning.selectDistance < 1)
    }
}

@Suite("Radial menu definition")
struct RadialMenuDefinitionTests {
    @Test("Accepts the default menu")
    func valid() throws {
        try sampleMenu().validate()
        #expect(sampleMenu().effectiveBundleID == "sh.paseo.desktop")
        #expect(RadialMenu(slots: [], bundleID: "com.example").effectiveBundleID == "com.example")
    }

    @Test("Refuses a menu without eight slots")
    func slotCount() {
        var menu = sampleMenu()
        menu.slots.removeLast()
        #expect(throws: RadialMenuError.slotCount(7)) { try menu.validate() }
    }

    @Test("Refuses an icon outside the curated list")
    func unknownIcon() {
        var menu = sampleMenu()
        menu.slots[3].icon = "applelogo"
        #expect(throws: RadialMenuError.unknownIcon(slot: 3, icon: "applelogo")) { try menu.validate() }
    }

    @Test("Refuses an empty or long label", arguments: ["", "  ", "A label that is far too long"])
    func invalidLabel(label: String) {
        var menu = sampleMenu()
        menu.slots[1].label = label
        #expect(throws: RadialMenuError.invalidLabel(slot: 1, label: label)) { try menu.validate() }
    }

    @Test("Refuses a color that is not #RRGGBB", arguments: ["green", "#12345", "#GG0000", "34C759"])
    func invalidColor(color: String) {
        var menu = sampleMenu()
        menu.slots[0].color = color
        #expect(throws: RadialMenuError.invalidColor(slot: 0, color: color)) { try menu.validate() }
    }

    @Test("Reads a slot's color as components")
    func rgb() {
        let slot = RadialMenuSlot(icon: "star", label: "Star", color: "#FF8000")
        #expect(slot.rgb?.red == 1)
        #expect(slot.rgb?.green == Double(0x80) / 255)
        #expect(slot.rgb?.blue == 0)
        #expect(RadialMenuSlot(icon: "star", label: "Star").rgb == nil)
    }

    @Test("Every curated icon is an SF Symbol, and no icon repeats")
    func iconsExist() {
        for icon in RadialMenuSlot.icons {
            #expect(NSImage(systemSymbolName: icon, accessibilityDescription: nil) != nil, "\(icon)")
        }
        #expect(Set(RadialMenuSlot.icons).count == RadialMenuSlot.icons.count)
    }

    @Test("The curated icons match the plugin's list")
    func iconsMatchPlugin() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Plugin/shared/radial-menu.ts")
        let text = try String(contentsOf: source, encoding: .utf8)
        let start = try #require(text.range(of: "export const RADIAL_MENU_ICONS = ["))
        let end = try #require(text.range(of: "] as const", range: start.upperBound ..< text.endIndex))
        let icons = text[start.upperBound ..< end.lowerBound]
            .split(separator: "\n")
            .compactMap { line -> String? in
                let parts = line.split(separator: "\"")
                return parts.count >= 2 ? String(parts[1]) : nil
            }
        #expect(icons == RadialMenuSlot.icons)
    }
}

@Suite("Radial menu placement")
struct RadialMenuPlacementTests {
    private let size = CGSize(width: 360, height: 360)
    private let main = CGRect(x: 0, y: 0, width: 1440, height: 875)

    @Test("Converts window bounds from display to screen coordinates")
    func convert() {
        let window = CGRect(x: 100, y: 50, width: 800, height: 600)
        #expect(
            RadialMenuPlacement.screenRect(fromDisplayRect: window, primaryHeight: 900)
                == CGRect(x: 100, y: 250, width: 800, height: 600)
        )
    }

    @Test("Centers the menu over the window")
    func centersOverWindow() {
        let window = CGRect(x: 200, y: 100, width: 1000, height: 700)
        let frame = RadialMenuPlacement.frame(size: size, over: window, screens: [main], mainScreen: main)
        #expect(frame == CGRect(x: 520, y: 270, width: 360, height: 360))
    }

    @Test("Falls back to the main screen's center without a window")
    func fallsBack() {
        let frame = RadialMenuPlacement.frame(size: size, over: nil, screens: [main], mainScreen: main)
        #expect(frame == CGRect(x: 540, y: 257.5, width: 360, height: 360))
    }

    @Test("Keeps the menu inside the screen of a small window near its edge")
    func clampsToScreen() {
        let window = CGRect(x: 1300, y: 760, width: 120, height: 110)
        let frame = RadialMenuPlacement.frame(size: size, over: window, screens: [main], mainScreen: main)
        #expect(frame == CGRect(x: 1080, y: 515, width: 360, height: 360))
    }

    @Test("Uses the screen that holds the window's center")
    func secondScreen() {
        let second = CGRect(x: 1440, y: 0, width: 1920, height: 1080)
        let window = CGRect(x: 2900, y: 0, width: 400, height: 400)
        let frame = RadialMenuPlacement.frame(size: size, over: window, screens: [main, second], mainScreen: main)
        #expect(frame == CGRect(x: 2920, y: 20, width: 360, height: 360))
    }
}

@Suite("Radial menu controller")
struct RadialMenuControllerTests {
    private let owner = UUID()
    private let other = UUID()

    private func onLayer(_ visible: Bool = true) -> KeypadState {
        KeypadState(connected: true, layer: visible ? 4 : 1)
    }

    @Test("Picks for the owner only, and reports the presentation while open")
    func ownerPicks() throws {
        let controller = RadialMenuController()
        controller.keypadChanged(onLayer())
        try controller.set(sampleMenu(), client: owner)
        #expect(controller.handle(stick(0.25, 1), client: other) == nil)
        #expect(controller.presentation == nil)
        #expect(controller.handle(stick(0.25, 1), client: owner) == nil)
        #expect(controller.presentation == RadialMenuPresentation(menu: sampleMenu(), highlighted: 0, isArmed: true))
        #expect(controller.handle(rest, client: owner) == 0)
        #expect(controller.presentation == nil)
    }

    @Test("Does not open off the input layers, and closes when the keypad leaves them")
    func layers() throws {
        let controller = RadialMenuController()
        try controller.set(sampleMenu(), client: owner)
        controller.keypadChanged(onLayer(false))
        _ = controller.handle(stick(0.25, 1), client: owner)
        #expect(controller.presentation == nil)
        controller.keypadChanged(onLayer())
        _ = controller.handle(stick(0.25, 1), client: owner)
        #expect(controller.presentation != nil)
        controller.keypadChanged(onLayer(false))
        #expect(controller.presentation == nil)
        #expect(controller.handle(rest, client: owner) == nil)
    }

    @Test("Does not open without a menu, and closes when the owner clears it")
    func clears() throws {
        let controller = RadialMenuController()
        controller.keypadChanged(onLayer())
        #expect(controller.handle(stick(0.25, 1), client: owner) == nil)
        #expect(controller.presentation == nil)
        try controller.set(sampleMenu(), client: owner)
        _ = controller.handle(stick(0.25, 1), client: owner)
        controller.clear(client: other)
        #expect(controller.presentation != nil)
        controller.clear(client: owner)
        #expect(controller.presentation == nil)
        #expect(controller.menu == nil)
    }

    @Test("A release on a slot that cannot act picks nothing")
    func disabledSlot() throws {
        let controller = RadialMenuController()
        controller.keypadChanged(onLayer())
        var enabled = Array(repeating: true, count: 8)
        enabled[4] = false
        try controller.set(sampleMenu(enabled: enabled), client: owner)
        _ = controller.handle(stick(0.75, 1), client: owner)
        #expect(controller.handle(rest, client: owner) == nil)
        _ = controller.handle(stick(0.25, 1), client: owner)
        #expect(controller.handle(rest, client: owner) == 0)
    }

    @Test("A new definition updates an open menu, and an invalid one changes nothing")
    func updates() throws {
        let controller = RadialMenuController()
        controller.keypadChanged(onLayer())
        try controller.set(sampleMenu(), client: owner)
        _ = controller.handle(stick(0.25, 1), client: owner)
        try controller.set(sampleMenu(target: nil), client: owner)
        #expect(controller.presentation?.menu.target == nil)
        var invalid = sampleMenu()
        invalid.slots[0].icon = "nope"
        #expect(throws: RadialMenuError.self) { try controller.set(invalid, client: other) }
        #expect(controller.presentation?.highlighted == 0)
    }

    @Test("Cancel closes an open menu without a pick, and the stick's return picks nothing")
    func cancel() throws {
        let controller = RadialMenuController()
        controller.keypadChanged(onLayer())
        try controller.set(sampleMenu(), client: owner)
        #expect(!controller.cancel())
        _ = controller.handle(stick(0.25, 1), client: owner)
        #expect(controller.presentation != nil)
        #expect(controller.cancel())
        #expect(controller.presentation == nil)
        #expect(controller.handle(stick(0.25, 1), client: owner) == nil)
        #expect(controller.presentation == nil)
        #expect(controller.handle(rest, client: owner) == nil)
        _ = controller.handle(stick(0.25, 1), client: owner)
        #expect(controller.handle(rest, client: owner) == 0)
    }

    @Test("A keypad key press or dial click cancels the open menu, and the owner gets neither it nor its release")
    func intercept() throws {
        let controller = RadialMenuController()
        controller.keypadChanged(onLayer())
        try controller.set(sampleMenu(), client: owner)
        let press = KeypadInput.key(KeyInput(key: 3, action: .press))
        let release = KeypadInput.key(KeyInput(key: 3, action: .release))
        // While the menu is closed, every input passes.
        #expect(!controller.intercept(press, client: owner))
        #expect(!controller.intercept(release, client: owner))

        _ = controller.handle(stick(0.25, 1), client: owner)
        // Another client's inputs pass and leave the menu open.
        #expect(!controller.intercept(press, client: other))
        #expect(controller.presentation != nil)
        // A joystick sector key does not cancel; a push that opens the menu sends one.
        #expect(!controller.intercept(.key(KeyInput(key: 17, action: .press)), client: owner))
        #expect(!controller.intercept(.dial(.clockwise), client: owner))
        #expect(controller.presentation != nil)

        #expect(controller.intercept(press, client: owner))
        #expect(controller.presentation == nil)
        #expect(controller.intercept(release, client: owner))
        #expect(!controller.intercept(release, client: owner))
        #expect(controller.handle(rest, client: owner) == nil)

        _ = controller.handle(stick(0.25, 1), client: owner)
        #expect(controller.intercept(.dial(.press), client: owner))
        #expect(controller.presentation == nil)
        #expect(controller.intercept(.dial(.release), client: owner))
        #expect(!controller.intercept(.dial(.release), client: owner))
        #expect(controller.handle(rest, client: owner) == nil)
    }

    @Test("Streams presentations in order and ends when finished")
    func stream() async throws {
        let controller = RadialMenuController()
        controller.keypadChanged(onLayer())
        try controller.set(sampleMenu(), client: owner)
        var iterator = controller.presentations.makeAsyncIterator()
        _ = controller.handle(stick(0.25, 0.6), client: owner)
        #expect(
            await iterator.next() == .some(RadialMenuPresentation(menu: sampleMenu(), highlighted: 0, isArmed: false))
        )
        _ = controller.handle(rest, client: owner)
        #expect(await iterator.next() == .some(nil))
        controller.finish()
        #expect(await iterator.next() == nil)
    }
}

@Suite("Radial menu over the bridge")
struct RadialMenuBridgeTests {
    @Test("Encodes and decodes setRadialMenu, clearRadialMenu, and a pick")
    func protocolForms() throws {
        let line = String(decoding: BridgeCommand(id: 3, .setRadialMenu(sampleMenu())).line(), as: UTF8.self)
        #expect(
            line.hasPrefix(
                ##"{"id":3,"slots":[{"color":"#34C759","enabled":true,"icon":"checkmark.circle","label":"Approve"}"##
            )
        )
        #expect(line.hasSuffix(#""target":"Fix the build","type":"setRadialMenu"}"# + "\n"))
        let decoded = try JSONDecoder().decode(BridgeCommand.self, from: Data(line.utf8))
        #expect(decoded == BridgeCommand(id: 3, .setRadialMenu(sampleMenu())))

        let plugin = #"{"type":"setRadialMenu","slots":[],"target":null,"bundleID":"sh.paseo.desktop"}"#
        #expect(
            try JSONDecoder().decode(BridgeCommand.self, from: Data(plugin.utf8))
                == BridgeCommand(.setRadialMenu(RadialMenu(slots: [], target: nil, bundleID: "sh.paseo.desktop")))
        )
        #expect(
            try JSONDecoder().decode(BridgeCommand.self, from: Data(#"{"type":"clearRadialMenu"}"#.utf8))
                == BridgeCommand(.clearRadialMenu)
        )

        let pick = BridgeMessage.radialPick(slot: 5).line()
        #expect(String(decoding: pick, as: UTF8.self) == #"{"input":{"kind":"radial","slot":5},"type":"input"}"# + "\n")
        #expect(try JSONDecoder().decode(BridgeMessage.self, from: pick) == .radialPick(slot: 5))
        let key = BridgeMessage.input(.key(KeyInput(key: 3, action: .press))).line()
        #expect(
            try JSONDecoder().decode(BridgeMessage.self, from: key) == .input(.key(KeyInput(key: 3, action: .press)))
        )
    }

    @Test("Sends a pick to the client that set the menu, refuses invalid menus, and clears on disconnect")
    func endToEnd() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.lightsVisible })
        let path = temporarySocketPath()
        let bridge = try await BridgeServer.bind(path: path, session: session, interface: RecordingInterface())
        let running = Task { try await bridge.run() }
        defer {
            bridge.close()
            running.cancel()
            try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        }

        let client = try await BridgeClient.connect(path: path)
        try await client.run { messages, writer in
            var iterator = messages.makeAsyncIterator()
            _ = try await iterator.next()

            var invalid = sampleMenu()
            invalid.slots[2].icon = "applelogo"
            try await writer.send(BridgeCommand(id: 1, .setRadialMenu(invalid)))
            var message = try await iterator.next()
            while case .input = message { message = try await iterator.next() }
            guard case .result(1, false, let error?) = message else {
                Issue.record("Expected a failed result, got \(String(describing: message))")
                return
            }
            #expect(error.contains("applelogo"))
            #expect(bridge.radialMenu.menu == nil)

            try await writer.send(BridgeCommand(id: 2, .setRadialMenu(sampleMenu())))
            #expect(try await iterator.next() == .result(id: 2, ok: true, error: nil))
            keypad.moveJoystick(angle: 0.75, distance: 1, sector: 4)
            keypad.moveJoystick(angle: 0.75, distance: 0.3, sector: 4)
            keypad.moveJoystick(angle: 0, distance: 0, sector: -1)
            var inputs: [BridgeMessage] = []
            while let message = try await iterator.next() {
                inputs.append(message)
                if case .radialPick = message { break }
            }
            // The positions reach the client too, and the pick follows the position at rest.
            #expect(inputs.count == 4)
            #expect(inputs.last == .radialPick(slot: 4))
        }
        #expect(await eventually { bridge.radialMenu.menu == nil })
        await session.stop()
    }
}

@Suite("Escape key filter")
struct EscapeKeyFilterTests {
    private typealias Event = (keyCode: Int64, isKeyDown: Bool, menuOpen: Bool)
    private let escape = EscapeKeyFilter.escapeKeyCode
    private let letterA: Int64 = 0

    /// Feeds key events to a filter and returns its decisions.
    private func decisions(_ filter: inout EscapeKeyFilter, _ events: [Event]) -> [EscapeKeyFilter.Decision] {
        events.map { filter.decide(keyCode: $0.keyCode, isKeyDown: $0.isKeyDown, menuOpen: $0.menuOpen) }
    }

    @Test("Drops Escape and cancels while the menu is open, and passes other keys")
    func dropsEscape() {
        var filter = EscapeKeyFilter()
        let open = decisions(
            &filter,
            [(letterA, true, true), (letterA, false, true), (escape, true, true)]
        )
        #expect(open == [.pass, .pass, .dropAndCancel])
        #expect(filter.awaitingKeyUp)
        // The menu closed; the key repeats and the key-up of the same keystroke are dropped too,
        // and the next Escape reaches Paseo.
        let closed = decisions(
            &filter,
            [(escape, true, false), (escape, false, false), (escape, true, false), (escape, false, false)]
        )
        #expect(closed == [.drop, .drop, .pass, .pass])
        #expect(!filter.awaitingKeyUp)
    }

    @Test("Passes the key-up of an Escape that started before the menu opened")
    func earlierKeystroke() {
        var filter = EscapeKeyFilter()
        #expect(decisions(&filter, [(escape, false, true)]) == [.pass])
    }

    @Test("A reset forgets a dropped key-down")
    func reset() {
        var filter = EscapeKeyFilter()
        #expect(decisions(&filter, [(escape, true, true)]) == [.dropAndCancel])
        filter.reset()
        #expect(decisions(&filter, [(escape, false, false)]) == [.pass])
    }
}

@Suite("Radial menu cancel over the bridge")
struct RadialMenuCancelBridgeTests {
    @Test("A key press cancels the open menu, and only the owner misses the press and its release")
    func keyCancels() async throws {
        let keypad = EmulatedKeypad()
        let session = await startSession(keypad)
        #expect(await eventually { await session.state.lightsVisible })
        let path = temporarySocketPath()
        let bridge = try await BridgeServer.bind(path: path, session: session, interface: RecordingInterface())
        let running = Task { try await bridge.run() }
        defer {
            bridge.close()
            running.cancel()
            try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
        }

        /// Reads messages until the release of key 5, which ends each test sequence.
        func readUntilKey5Release(_ iterator: inout BridgeClient.Messages.AsyncIterator) async throws
            -> [BridgeMessage]
        {
            var messages: [BridgeMessage] = []
            while let message = try await iterator.next() {
                messages.append(message)
                if message == .input(.key(KeyInput(key: 5, action: .release))) { break }
            }
            return messages
        }
        func keys(_ messages: [BridgeMessage]) -> [Int] {
            messages.compactMap { if case .input(.key(let key)) = $0 { key.key } else { nil } }
        }

        let owner = try await BridgeClient.connect(path: path)
        let observer = try await BridgeClient.connect(path: path)
        try await owner.run { ownerMessages, writer in
            try await observer.run { observerMessages, _ in
                var ownerInbox = ownerMessages.makeAsyncIterator()
                var observerInbox = observerMessages.makeAsyncIterator()
                _ = try await ownerInbox.next()
                _ = try await observerInbox.next()
                try await writer.send(BridgeCommand(id: 1, .setRadialMenu(sampleMenu())))
                #expect(try await ownerInbox.next() == .result(id: 1, ok: true, error: nil))

                keypad.moveJoystick(angle: 0.75, distance: 1, sector: 4)
                #expect(await eventually { bridge.radialMenu.presentation != nil })
                keypad.tap(key: 3)
                #expect(await eventually { bridge.radialMenu.presentation == nil })
                keypad.moveJoystick(angle: 0.75, distance: 0.3, sector: 4)
                keypad.moveJoystick(angle: 0, distance: 0, sector: -1)
                keypad.tap(key: 5)

                let ownerSaw = try await readUntilKey5Release(&ownerInbox)
                #expect(keys(ownerSaw) == [5, 5])
                #expect(!ownerSaw.contains { if case .radialPick = $0 { true } else { false } })
                #expect(keys(try await readUntilKey5Release(&observerInbox)) == [3, 3, 5, 5])
            }
        }
        await session.stop()
    }
}
