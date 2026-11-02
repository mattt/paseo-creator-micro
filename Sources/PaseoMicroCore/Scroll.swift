import CoreGraphics
import Foundation

/// An edge of a window's content, which the bridge's `scroll` command scrolls toward in a burst.
public enum ScrollEdge: String, Sendable, Hashable, CaseIterable, Codable {
    /// The start of the content, such as a conversation's oldest messages.
    case top
    /// The end of the content, such as a conversation's newest messages.
    case bottom
}

/// A scroll for the bridge's `scroll` command: a number of lines at a point in an app's window.
///
/// Positive lines scroll down, toward the end of the content,
/// and negative lines scroll up.
/// The point is at the window's horizontal center,
/// at ``fromTop`` of the window's height from its top edge.
///
/// The app posts a scroll as one or more line-unit scroll-wheel events (``events``),
/// each of at most ``maximumLines`` lines, about ``burstInterval`` apart.
/// A scroll to an edge is a burst of ``edgeLines`` lines toward the edge.
public struct ScrollRequest: Sendable, Hashable {
    /// The most lines that one command with `lines` may scroll, in either direction,
    /// and the most lines that any one scroll-wheel event that the app posts may carry.
    ///
    /// One event of 32,767 lines toward the top of a conversation made the Paseo 0.13 app
    /// fail with React error #185, "Maximum update depth exceeded",
    /// so no event carries more than this.
    public static let maximumLines = 100

    /// The lines of a scroll to an edge, toward the edge: ten events of ``maximumLines``.
    ///
    /// Chromium, which Paseo's window uses, scrolls a line-unit event
    /// by its delta times `kScrollbarPixelsPerCocoaTick`, 40 points,
    /// so this scrolls about 40,000 points and stops at the edge of the content.
    /// That reaches the bottom of a normal conversation.
    /// Toward the top it goes up about 1,000 lines,
    /// because Paseo loads older messages as the scroll nears the top.
    public static let edgeLines = 1_000

    /// The time between the events of a scroll that needs more than one, about one frame at 60 Hz,
    /// so that the app renders between them.
    public static let burstInterval: Duration = .milliseconds(16)

    /// The default height of the point, as a fraction of the window's height from its top edge.
    ///
    /// In Paseo, 40% from the top is inside an agent's conversation, above the composer.
    public static let defaultFromTop = 0.4

    /// The lines to scroll: positive down, negative up, never zero.
    ///
    /// At most ``maximumLines`` in either direction, or ``edgeLines`` for a scroll to an edge.
    public var lines: Int

    /// The height of the point, as a fraction of the window's height from its top edge,
    /// greater than 0 and less than 1.
    public var fromTop: Double

    /// Checks and creates a scroll.
    ///
    /// - Parameters:
    ///   - lines: The lines to scroll: positive down, negative up.
    ///   - fromTop: The height of the point, as a fraction of the window's height from its top.
    /// - Throws: ``InterfaceError/invalidScrollLines(_:)`` if `lines` is zero
    ///   or more than ``maximumLines`` in either direction,
    ///   or ``InterfaceError/invalidScrollPosition(_:)`` if `fromTop` is not between 0 and 1.
    public init(lines: Int, fromTop: Double = ScrollRequest.defaultFromTop) throws {
        guard lines != 0, lines.magnitude <= Self.maximumLines else {
            throw InterfaceError.invalidScrollLines(lines)
        }
        self.lines = lines
        self.fromTop = try Self.checked(fromTop)
    }

    /// Checks and creates a scroll toward an edge of the content.
    ///
    /// The scroll is ``edgeLines`` lines toward the edge, in a burst of events
    /// of ``maximumLines`` each; the app stops it at the edge.
    ///
    /// - Parameters:
    ///   - edge: The edge to reach.
    ///   - fromTop: The height of the point, as a fraction of the window's height from its top.
    /// - Throws: ``InterfaceError/invalidScrollPosition(_:)`` if `fromTop` is not between 0 and 1.
    public init(edge: ScrollEdge, fromTop: Double = ScrollRequest.defaultFromTop) throws {
        self.lines = edge == .bottom ? Self.edgeLines : -Self.edgeLines
        self.fromTop = try Self.checked(fromTop)
    }

    private static func checked(_ fromTop: Double) throws -> Double {
        guard fromTop.isFinite, fromTop > 0, fromTop < 1 else {
            throw InterfaceError.invalidScrollPosition(fromTop)
        }
        return fromTop
    }

    /// The point at which to scroll in a window, in global display coordinates
    /// (origin at the top left of the main display, y increasing downward),
    /// which are the coordinates of window bounds and of event locations.
    ///
    /// - Parameter bounds: The window's bounds, in global display coordinates.
    /// - Returns: The point at the window's horizontal center, ``fromTop`` of its height from the top.
    public func point(in bounds: CGRect) -> CGPoint {
        let bounds = bounds.standardized
        return CGPoint(x: bounds.midX, y: bounds.minY + bounds.height * fromTop)
    }

    /// The lines of each scroll-wheel event that the scroll posts, in order:
    /// ``lines`` split into events of at most ``maximumLines``, all in its direction.
    public var events: [Int] {
        let sign = lines < 0 ? -1 : 1
        var remaining = lines.magnitude
        var events: [Int] = []
        while remaining > 0 {
            let step = min(remaining, UInt(Self.maximumLines))
            events.append(sign * Int(step))
            remaining -= step
        }
        return events
    }

    /// The value for a line-unit scroll-wheel event's first wheel that scrolls a number of lines.
    ///
    /// A positive wheel value scrolls the content up, toward its start,
    /// so scrolling down needs a negative value.
    /// The lines are limited to ``maximumLines`` in either direction,
    /// so no event that the app posts carries more, whatever it is asked.
    ///
    /// - Parameter lines: The lines to scroll: positive down, negative up.
    /// - Returns: The wheel value, from −``maximumLines`` to ``maximumLines``.
    public static func wheelDelta(lines: Int) -> Int32 {
        Int32(-lines.clamped(to: -maximumLines ... maximumLines))
    }
}

extension Int {
    fileprivate func clamped(to range: ClosedRange<Int>) -> Int {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}

/// A window of a running app, as the bridge's `scroll` command targets it.
public struct AppWindow: Sendable, Hashable {
    /// The process that owns the window.
    public var processID: pid_t
    /// The window server's number for the window.
    public var windowNumber: Int
    /// The window's bounds in global display coordinates (origin at the top left of the main display).
    public var bounds: CGRect

    /// Creates a window description.
    ///
    /// - Parameters:
    ///   - processID: The process that owns the window.
    ///   - windowNumber: The window server's number for the window.
    ///   - bounds: The window's bounds in global display coordinates.
    public init(processID: pid_t, windowNumber: Int, bounds: CGRect) {
        self.processID = processID
        self.windowNumber = windowNumber
        self.bounds = bounds
    }

    /// The smallest width and height of a window that can hold a conversation;
    /// smaller windows, such as panels and status items, are skipped.
    static let minimumSide: CGFloat = 100

    /// Picks the frontmost normal window of a process from the window server's on-screen list.
    ///
    /// - Parameters:
    ///   - list: Window descriptions from `CGWindowListCopyWindowInfo`, front to back.
    ///   - processID: The process whose window to find.
    /// - Returns: The first window of the process at the normal level (layer 0)
    ///   that is at least ``minimumSide`` points wide and tall, or `nil`.
    static func frontmost(in list: [[String: Any]], processID: pid_t) -> AppWindow? {
        for info in list {
            guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == processID,
                (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                let number = (info[kCGWindowNumber as String] as? NSNumber)?.intValue,
                let dictionary = info[kCGWindowBounds as String] as? NSDictionary,
                let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
                bounds.width >= minimumSide, bounds.height >= minimumSide
            else { continue }
            return AppWindow(processID: processID, windowNumber: number, bounds: bounds)
        }
        return nil
    }
}
