import AppKit

/// The Creator Micro silhouette and its connection or lighting indicator.
@MainActor
enum MenuBarIcon: String, CaseIterable {
    case connected
    case disconnected
    case attention

    var image: NSImage { Self.images[self == .disconnected ? .connected : self]! }

    var opacity: Double { self == .disconnected ? 0.4 : 1 }

    private static let images: [Self: NSImage] = Dictionary(
        uniqueKeysWithValues: [Self.connected, .attention].map { state in
            let url = Bundle.module.url(forResource: "Keypad-\(state.rawValue)", withExtension: "pdf")!
            let image = NSImage(contentsOf: url)!
            image.size = NSSize(width: 24, height: 18)
            image.isTemplate = true
            return (state, image)
        }
    )
}
