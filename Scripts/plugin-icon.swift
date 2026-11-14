// Run from the repository root with Xcode's Swift toolchain:
// swift Scripts/plugin-icon.swift [preview-directory]
// Regenerates the plugin's manifest icon from the app icon's dark appearance
// and renders it at 512, 64, and 32 pixels on Paseo's dark and light backgrounds.
import AppKit
import SwiftUI
import UniformTypeIdentifiers

let keysURL = URL(fileURLWithPath: "App/AppIcon.icon/Assets/KeysDark.svg")
let iconURL = URL(fileURLWithPath: "Plugin/assets/icon.png")
let previews = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "/tmp/paseo-micro-icons")
try FileManager.default.createDirectory(at: previews, withIntermediateDirectories: true)

let size = 512
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

// The macOS icon grid: an 824-point tile, centered on a 1024-point canvas,
// with continuous corners. The app icon's 1024-point layers span the tile.
let tile = CGRect(x: 50, y: 50, width: 412, height: 412)
let cornerRadius: CGFloat = 107
// The dark fill in App/AppIcon.icon/icon.json.
let tileColor = CGColor(colorSpace: sRGB, components: [0.14, 0.14, 0.16, 1])!
// The keys' color, #EDEDF0, at partial opacity,
// so the edge shows on dark backgrounds without competing with the keys.
let outlineColor = CGColor(colorSpace: sRGB, components: [0.93, 0.93, 0.94, 0.5])!
let outlineWidth: CGFloat = 5

func makeContext(width: Int, height: Int) -> CGContext {
    CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: sRGB,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
}

func tilePath(_ rect: CGRect, radius: CGFloat) -> CGPath {
    RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect).cgPath
}

func writePNG(_ image: CGImage, to url: URL) {
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    precondition(CGImageDestinationFinalize(destination))
}

let context = makeContext(width: size, height: size)
context.addPath(tilePath(tile, radius: cornerRadius))
context.setFillColor(tileColor)
context.fillPath()

// Stroke inside the tile, so the outline keeps the tile's footprint.
let inset = outlineWidth / 2
context.addPath(tilePath(tile.insetBy(dx: inset, dy: inset), radius: cornerRadius - inset))
context.setStrokeColor(outlineColor)
context.setLineWidth(outlineWidth)
context.strokePath()

guard let keys = NSImage(contentsOf: keysURL) else { fatalError("Cannot read \(keysURL.path)") }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
keys.draw(in: tile)
NSGraphicsContext.restoreGraphicsState()

let icon = context.makeImage()!
writePNG(icon, to: iconURL)

// Paseo's surface0 colors in its dark and light themes.
for (name, background) in [("dark", (0x10, 0x10, 0x12)), ("light", (0xFF, 0xFF, 0xFF))] {
    for pixels in [512, 64, 32] {
        let margin = pixels / 4
        let preview = makeContext(width: pixels + 2 * margin, height: pixels + 2 * margin)
        preview.setFillColor(
            CGColor(
                colorSpace: sRGB,
                components: [
                    CGFloat(background.0) / 255, CGFloat(background.1) / 255, CGFloat(background.2) / 255, 1,
                ]
            )!
        )
        preview.fill(CGRect(x: 0, y: 0, width: preview.width, height: preview.height))
        preview.interpolationQuality = .high
        preview.draw(icon, in: CGRect(x: margin, y: margin, width: pixels, height: pixels))
        writePNG(preview.makeImage()!, to: previews.appendingPathComponent("plugin-icon-\(name)-\(pixels).png"))
    }
}
