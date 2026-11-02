import CoreGraphics
import Foundation
@testable import PaseoMicroCore
import Testing

@Suite("Scrolling")
struct ScrollTests {
    @Test("Scrolls accept whole lines up to the limit and a position inside the window")
    func valid() throws {
        let down = try ScrollRequest(lines: 3)
        #expect(down.lines == 3)
        #expect(down.fromTop == 0.4)
        #expect(try ScrollRequest(lines: -ScrollRequest.maximumLines, fromTop: 0.01).lines == -100)
        #expect(try ScrollRequest(lines: ScrollRequest.maximumLines, fromTop: 0.99).fromTop == 0.99)
    }

    @Test("Scrolls refuse zero lines and too many lines", arguments: [0, 101, -101, Int.min, Int.max])
    func refusesLines(lines: Int) {
        #expect(throws: InterfaceError.invalidScrollLines(lines)) { try ScrollRequest(lines: lines) }
    }

    @Test("Scrolls refuse a position outside the window", arguments: [0, 1, -0.2, 1.5, .infinity])
    func refusesPosition(fromTop: Double) {
        #expect(throws: InterfaceError.invalidScrollPosition(fromTop)) {
            try ScrollRequest(lines: 1, fromTop: fromTop)
        }
    }

    @Test("Refuses a position that is not a number")
    func refusesNaN() {
        #expect(throws: InterfaceError.self) { try ScrollRequest(lines: 1, fromTop: .nan) }
    }

    @Test("The point is at the window's horizontal center, a fraction of its height from the top")
    func point() throws {
        let window = CGRect(x: 100, y: 50, width: 800, height: 600)
        #expect(try ScrollRequest(lines: 1).point(in: window) == CGPoint(x: 500, y: 290))
        #expect(try ScrollRequest(lines: 1, fromTop: 0.5).point(in: window) == CGPoint(x: 500, y: 350))
        // A window on a display to the left of the main display has negative coordinates.
        let left = CGRect(x: -1200, y: -100, width: 1000, height: 1000)
        #expect(try ScrollRequest(lines: 1).point(in: left) == CGPoint(x: -700, y: 300))
        // Bounds with a negative size are standardized first.
        let flipped = CGRect(x: 900, y: 650, width: -800, height: -600)
        #expect(try ScrollRequest(lines: 1).point(in: flipped) == CGPoint(x: 500, y: 290))
    }

    @Test("A scroll to an edge is a burst of 1,000 lines toward the edge, at most 100 lines per event")
    func edge() throws {
        #expect(ScrollRequest.edgeLines == 1_000)
        let bottom = try ScrollRequest(edge: .bottom)
        #expect(bottom.lines == 1_000)
        #expect(bottom.events == Array(repeating: 100, count: 10))
        #expect(bottom.fromTop == ScrollRequest.defaultFromTop)
        let top = try ScrollRequest(edge: .top, fromTop: 0.3)
        #expect(top.events == Array(repeating: -100, count: 10))
        #expect(top.fromTop == 0.3)
        #expect(throws: InterfaceError.invalidScrollPosition(1)) { try ScrollRequest(edge: .top, fromTop: 1) }
    }

    @Test("A scroll of lines is one event")
    func lineEvents() throws {
        #expect(try ScrollRequest(lines: 3).events == [3])
        #expect(try ScrollRequest(lines: -100).events == [-100])
    }

    @Test("Splits any line count into events of at most 100 lines in its direction")
    func splits() throws {
        var scroll = try ScrollRequest(lines: 1)
        scroll.lines = 250
        #expect(scroll.events == [100, 100, 50])
        scroll.lines = -32_767
        #expect(scroll.events.count == 328)
        #expect(scroll.events.allSatisfy { $0 < 0 && $0 >= -100 })
        #expect(scroll.events.reduce(0, +) == -32_767)
    }

    @Test("Scrolling down is a negative wheel value, capped at 100 lines whatever the request")
    func wheel() {
        #expect(ScrollRequest.wheelDelta(lines: 3) == -3)
        #expect(ScrollRequest.wheelDelta(lines: -2) == 2)
        #expect(ScrollRequest.wheelDelta(lines: 32_767) == -100)
        #expect(ScrollRequest.wheelDelta(lines: -32_767) == 100)
        #expect(ScrollRequest.wheelDelta(lines: Int.min) == 100)
        #expect(ScrollRequest.wheelDelta(lines: Int.max) == -100)
    }

    @Test("A capped event keeps its sign in a line-unit scroll-wheel event", arguments: [100, -100])
    func edgeEvent(lines: Int) throws {
        let wheel = ScrollRequest.wheelDelta(lines: lines)
        let event = try #require(
            CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: wheel, wheel2: 0, wheel3: 0)
        )
        #expect(event.getIntegerValueField(.scrollWheelEventDeltaAxis1) == Int64(wheel))
        #expect(event.getDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1) == Double(wheel))
    }

    private static let window = AppWindow(
        processID: 4242,
        windowNumber: 77,
        bounds: CGRect(x: 100, y: 50, width: 800, height: 600)
    )

    @Test("Posts a scroll to an edge as a paced burst with the pointer in the window, then puts the pointer back")
    func burst() async throws {
        let interface = RecordingInterface(frontmost: "app", windows: ["app": Self.window])
        let sender = EventSender(interface: interface)
        try await sender.scroll(try ScrollRequest(edge: .top), bundleID: "app", activate: false)
        #expect(interface.scrollWheels == Array(repeating: 100, count: 10))
        let point = CGPoint(x: 500, y: 290)
        #expect(
            interface.calls.allSatisfy {
                if case .scroll(_, let at, 77, "app") = $0 { at == point } else { false }
            }
        )
        #expect(interface.pointerMoves == [point, RecordingInterface.home])
        #expect(interface.pointer == RecordingInterface.home)
        let times = interface.scrollTimes
        for (earlier, later) in zip(times, times.dropFirst()) {
            #expect(later - earlier >= ScrollRequest.burstInterval)
        }

        try await sender.scroll(try ScrollRequest(edge: .bottom), bundleID: "app", activate: false)
        #expect(interface.scrollWheels.suffix(10) == Array(repeating: -100, count: 10))
        #expect(interface.pointer == RecordingInterface.home)
    }

    @Test("A canceled burst posts no more events and puts the pointer back")
    func canceledBurst() async throws {
        let interface = RecordingInterface(frontmost: "app", windows: ["app": Self.window])
        let sender = EventSender(interface: interface, scrollInterval: .milliseconds(50))
        let scroll = try ScrollRequest(edge: .bottom)
        let task = Task { try await sender.scroll(scroll, bundleID: "app", activate: false) }
        #expect(await eventually { interface.scrollWheels.count >= 2 })
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
        let posted = interface.scrollWheels.count
        #expect(posted < 10)
        #expect(interface.pointer == RecordingInterface.home)
        try await Task.sleep(for: .milliseconds(150))
        #expect(interface.scrollWheels.count == posted)
    }

    @Test("A scroll canceled before it starts neither moves the pointer nor posts")
    func canceledBeforeStart() async throws {
        let interface = RecordingInterface(frontmost: "app", windows: ["app": Self.window])
        let sender = EventSender(interface: interface)
        let scroll = try ScrollRequest(edge: .bottom)
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            try await sender.scroll(scroll, bundleID: "app", activate: false)
        }
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(interface.scrollWheels.isEmpty)
        #expect(interface.pointer == RecordingInterface.home)
    }

    private func info(pid: Int32, layer: Int = 0, number: Int, bounds: CGRect) -> [String: Any] {
        [
            kCGWindowOwnerPID as String: NSNumber(value: pid),
            kCGWindowLayer as String: NSNumber(value: layer),
            kCGWindowNumber as String: NSNumber(value: number),
            kCGWindowBounds as String: bounds.dictionaryRepresentation as NSDictionary,
        ]
    }

    @Test("Picks the app's frontmost normal window that can hold a conversation")
    func frontmostWindow() {
        let big = CGRect(x: 0, y: 25, width: 1200, height: 800)
        let list = [
            info(pid: 7, number: 1, bounds: big),
            info(pid: 42, layer: 25, number: 2, bounds: big),
            info(pid: 42, number: 3, bounds: CGRect(x: 0, y: 0, width: 300, height: 40)),
            info(pid: 42, number: 4, bounds: big),
            info(pid: 42, number: 5, bounds: big),
        ]
        #expect(
            AppWindow.frontmost(in: list, processID: 42) == AppWindow(processID: 42, windowNumber: 4, bounds: big)
        )
        #expect(AppWindow.frontmost(in: list, processID: 9) == nil)
        #expect(AppWindow.frontmost(in: [["kCGWindowOwnerPID": "42"]], processID: 42) == nil)
    }

    @Test("Scroll commands parse, with activate off and the default position unless given")
    func parses() throws {
        let decode = { (line: String) in try JSONDecoder().decode(BridgeCommand.self, from: Data(line.utf8)) }
        #expect(
            try decode(#"{"type":"scroll","id":3,"bundleID":"sh.paseo.desktop","lines":3}"#)
                == BridgeCommand(id: 3, .scroll(lines: 3, bundleID: "sh.paseo.desktop", activate: false, fromTop: nil))
        )
        #expect(
            try decode(#"{"type":"scroll","bundleID":"a","lines":-2,"activate":true,"fromTop":0.3}"#)
                == BridgeCommand(.scroll(lines: -2, bundleID: "a", activate: true, fromTop: 0.3))
        )
        for bad in [
            #"{"type":"scroll","lines":3}"#,
            #"{"type":"scroll","bundleID":"a"}"#,
            #"{"type":"scroll","bundleID":"a","lines":1.5}"#,
            #"{"type":"scroll","bundleID":"a","lines":"3"}"#,
            #"{"type":"scroll","bundleID":"a","lines":3,"edge":"top"}"#,
            #"{"type":"scroll","bundleID":"a","edge":"middle"}"#,
            #"{"type":"scroll","edge":"top"}"#,
        ] {
            #expect(throws: DecodingError.self) { try decode(bad) }
        }
        let command = BridgeCommand(id: 4, .scroll(lines: 3, bundleID: "a", activate: true, fromTop: 0.4))
        #expect(try JSONDecoder().decode(BridgeCommand.self, from: command.line()) == command)
    }

    @Test("Scroll commands with an edge parse and encode as scroll commands")
    func parsesEdges() throws {
        let decode = { (line: String) in try JSONDecoder().decode(BridgeCommand.self, from: Data(line.utf8)) }
        #expect(
            try decode(#"{"type":"scroll","id":5,"bundleID":"sh.paseo.desktop","edge":"bottom","activate":true}"#)
                == BridgeCommand(
                    id: 5,
                    .scrollToEdge(.bottom, bundleID: "sh.paseo.desktop", activate: true, fromTop: nil)
                )
        )
        let top = BridgeCommand(id: 6, .scrollToEdge(.top, bundleID: "a", activate: false, fromTop: 0.3))
        let line = String(decoding: top.line(), as: UTF8.self)
        #expect(line == #"{"activate":false,"bundleID":"a","edge":"top","fromTop":0.3,"id":6,"type":"scroll"}"# + "\n")
        #expect(try decode(line) == top)
    }
}
