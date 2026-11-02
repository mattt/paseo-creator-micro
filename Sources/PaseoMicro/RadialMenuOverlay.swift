import AppKit
import Observation
import PaseoMicroCore
import SwiftUI

/// Shows the radial menu over Paseo's frontmost window while the joystick holds it open.
///
/// The menu is a borderless, transparent panel that never becomes key or main,
/// so Paseo keeps its focus and its key window; it ignores the mouse,
/// floats above normal windows, and joins every space.
/// It fades in when the menu opens and out when it closes.
@MainActor
final class RadialMenuOverlay {
    /// How long the menu takes to fade in or out.
    static let fadeDuration: TimeInterval = 0.12

    private let model = RadialMenuOverlayModel()
    private lazy var panel = makePanel()
    /// Counts fades, so that a fade-out that ends after a newer fade-in leaves the panel up.
    private var generation = 0
    private var isOpen = false

    /// Shows, updates, or hides the menu.
    ///
    /// - Parameter presentation: What to draw, or `nil` to hide the menu.
    func show(_ presentation: RadialMenuPresentation?) {
        generation += 1
        if let presentation {
            model.presentation = presentation
            guard !isOpen else { return }
            isOpen = true
            panel.setFrame(frame(for: presentation.menu), display: false)
            if !panel.isVisible { panel.alphaValue = 0 }
            panel.orderFrontRegardless()
            fade(to: 1)
        } else if isOpen {
            isOpen = false
            let ending = generation
            // The last presentation stays while the menu fades out.
            fade(to: 0) { [weak self] in
                guard let self, self.generation == ending else { return }
                self.panel.orderOut(nil)
                self.model.presentation = nil
            }
        }
    }

    private func fade(to alpha: CGFloat, completion: (@MainActor () -> Void)? = nil) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = Self.fadeDuration
            panel.animator().alphaValue = alpha
        } completionHandler: {
            MainActor.assumeIsolated { completion?() }
        }
    }

    /// Over the app's frontmost window, else in the middle of the main screen.
    private func frame(for menu: RadialMenu) -> CGRect {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let window = (try? SystemInterfaceDriver.frontWindow(bundleIdentifier: menu.effectiveBundleID))
            .map { RadialMenuPlacement.screenRect(fromDisplayRect: $0.bounds, primaryHeight: primaryHeight) }
        let side = RadialMenuView.side
        return RadialMenuPlacement.frame(
            size: CGSize(width: side, height: side),
            over: window,
            screens: NSScreen.screens.map(\.visibleFrame),
            mainScreen: NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: side, height: side)
        )
    }

    private func makePanel() -> NSPanel {
        let side = RadialMenuView.side
        let panel = OverlayPanel(
            contentRect: CGRect(x: 0, y: 0, width: side, height: side),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.contentView = NSHostingView(rootView: RadialMenuOverlayContent(model: model))
        return panel
    }
}

/// A panel that never takes key or main status from the app in front.
private final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The presentation that the overlay draws; the last one stays while the menu fades out.
@MainActor
@Observable
private final class RadialMenuOverlayModel {
    var presentation: RadialMenuPresentation?
}

private struct RadialMenuOverlayContent: View {
    let model: RadialMenuOverlayModel

    var body: some View {
        if let presentation = model.presentation {
            RadialMenuView(presentation: presentation)
        } else {
            Color.clear.frame(width: RadialMenuView.side, height: RadialMenuView.side)
        }
    }
}
