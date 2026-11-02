import CoreGraphics

/// Where the radial menu's panel goes: over the middle of an app's frontmost window,
/// else in the middle of the main screen, and always inside one screen.
public enum RadialMenuPlacement {
    /// Converts a rectangle in global display coordinates, which `CGWindowListCopyWindowInfo` uses
    /// (origin at the top left of the primary display, y down),
    /// to screen coordinates, which `NSWindow` uses (origin at the bottom left of the primary display, y up).
    ///
    /// - Parameters:
    ///   - rect: The rectangle in global display coordinates.
    ///   - primaryHeight: The height of the primary display, the screen whose frame has its origin at zero.
    /// - Returns: The same rectangle in screen coordinates.
    public static func screenRect(fromDisplayRect rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    /// The panel's frame in screen coordinates.
    ///
    /// The panel is centered on the window, or on the main screen without a window,
    /// then moved, if it must, to lie inside the screen that holds that center
    /// (the main screen when no screen holds it).
    ///
    /// - Parameters:
    ///   - size: The panel's size.
    ///   - window: The window's frame in screen coordinates, or `nil` for none.
    ///   - screens: The screens' visible frames in screen coordinates.
    ///   - mainScreen: The main screen's visible frame, the fallback.
    /// - Returns: The panel's frame.
    public static func frame(size: CGSize, over window: CGRect?, screens: [CGRect], mainScreen: CGRect) -> CGRect {
        let center = CGPoint(x: (window ?? mainScreen).midX, y: (window ?? mainScreen).midY)
        let screen = screens.first { $0.contains(center) } ?? mainScreen
        var frame = CGRect(
            x: center.x - size.width / 2,
            y: center.y - size.height / 2,
            width: size.width,
            height: size.height
        )
        frame.origin.x = clamp(frame.minX, lower: screen.minX, upper: screen.maxX - size.width)
        frame.origin.y = clamp(frame.minY, lower: screen.minY, upper: screen.maxY - size.height)
        return frame
    }

    /// Keeps a value between two bounds; when the bounds cross, as for a panel wider than its screen,
    /// the lower bound wins, so that the panel's leading or bottom edge shows.
    private static func clamp(_ value: CGFloat, lower: CGFloat, upper: CGFloat) -> CGFloat {
        max(lower, min(value, upper))
    }
}
