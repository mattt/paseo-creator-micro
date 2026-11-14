// Run from the repository root with Xcode's Swift toolchain:
// swift Scripts/plugin-icon.swift [preview-directory]
// Regenerates the plugin's manifest icon, a light-on-dark keypad
// in the proportions of the physical unit, and renders it at 512, 64, and 32 pixels
// on Paseo's dark and light backgrounds.
import AppKit
import SwiftUI
import UniformTypeIdentifiers

let iconURL = URL(fileURLWithPath: "Plugin/assets/icon.png")
let previews = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "/tmp/paseo-micro-icons")
try FileManager.default.createDirectory(at: previews, withIntermediateDirectories: true)

let size = 512
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

// The tile keeps the macOS icon grid's footprint: 824 of 1024 points, centered.
let tile = CGRect(x: 50, y: 50, width: 412, height: 412)

// KeypadMetrics in Sources/PaseoMicroMenu/KeypadParts.swift, in points:
// the body is the tile, and the keys fill the grid at its center.
let bodyPoints: CGFloat = 207
let bodyCornerPoints: CGFloat = 32
let keyPoints: CGFloat = 36
let gapPoints: CGFloat = 5
let scale = tile.width / bodyPoints
let cornerRadius = bodyCornerPoints * scale
let key = keyPoints * scale
let gap = gapPoints * scale
let grid = key * 4 + gap * 3
let gridOrigin = CGPoint(x: tile.midX - grid / 2, y: tile.midY - grid / 2)

// The dark fill in App/AppIcon.icon/icon.json and the keys in KeysDark.svg.
let tileColor = CGColor(colorSpace: sRGB, components: [0.14, 0.14, 0.16, 1])!
let keyColor = CGColor(colorSpace: sRGB, components: [0xED / 255, 0xED / 255, 0xF0 / 255, 1])!
// The keys' color at partial opacity,
// so the edge shows on dark backgrounds without competing with the keys.
let outlineColor = keyColor.copy(alpha: 0.5)!
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

// Maps a key slot's coordinates in KeysDark.svg, where a key is 112 units square
// with 26-unit corners and y points down, to the slot at a column and row of the grid.
let units = key / 112

func slot(column: Int, row: Int) -> CGAffineTransform {
    let origin = CGPoint(
        x: gridOrigin.x + CGFloat(column) * (key + gap),
        y: gridOrigin.y + CGFloat(row) * (key + gap)
    )
    return CGAffineTransform(a: units, b: 0, c: 0, d: -units, tx: origin.x, ty: CGFloat(size) - origin.y)
}

func addKey(_ path: CGMutablePath, column: Int, row: Int, columns: Int = 1) {
    // A wider key spans its slots and the gaps between them.
    let width = (CGFloat(columns) * (key + gap) - gap) / units
    path.addRoundedRect(
        in: CGRect(x: 0, y: 0, width: width, height: 112),
        cornerWidth: 26,
        cornerHeight: 26,
        transform: slot(column: column, row: row)
    )
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

context.setFillColor(keyColor)

// The dial: a half disc, rotated about its slot's center to face the top left.
let dial = CGMutablePath()
let dialTransform = CGAffineTransform(translationX: -56, y: -56)
    .concatenating(CGAffineTransform(rotationAngle: -.pi / 4))
    .concatenating(CGAffineTransform(translationX: 56 - 11.6, y: 56 - 11.6))
    .concatenating(slot(column: 0, row: 0))
dial.addArc(
    center: CGPoint(x: 56, y: 84),
    radius: 56,
    startAngle: .pi,
    endAngle: 0,
    clockwise: false,
    transform: dialTransform
)
dial.closeSubpath()
context.addPath(dial)
context.fillPath()

// The joystick: a key with quadratic corners and a round hole.
let stick = slot(column: 3, row: 0)
let joystick = CGMutablePath()
joystick.move(to: CGPoint(x: 26, y: 0), transform: stick)
joystick.addLine(to: CGPoint(x: 86, y: 0), transform: stick)
joystick.addQuadCurve(to: CGPoint(x: 112, y: 26), control: CGPoint(x: 112, y: 0), transform: stick)
joystick.addLine(to: CGPoint(x: 112, y: 86), transform: stick)
joystick.addQuadCurve(to: CGPoint(x: 86, y: 112), control: CGPoint(x: 112, y: 112), transform: stick)
joystick.addLine(to: CGPoint(x: 26, y: 112), transform: stick)
joystick.addQuadCurve(to: CGPoint(x: 0, y: 86), control: CGPoint(x: 0, y: 112), transform: stick)
joystick.addLine(to: CGPoint(x: 0, y: 26), transform: stick)
joystick.addQuadCurve(to: CGPoint(x: 26, y: 0), control: CGPoint(x: 0, y: 0), transform: stick)
joystick.closeSubpath()
joystick.addEllipse(in: CGRect(x: 22, y: 22, width: 68, height: 68), transform: stick)
context.addPath(joystick)
context.fillPath(using: .evenOdd)

// The keys on the four-column grid: rows of 2, 4, 4, and 3,
// with the bottom row's first slot empty and a double-wide key after it.
let keys = CGMutablePath()
addKey(keys, column: 1, row: 0)
addKey(keys, column: 2, row: 0)
for row in 1...2 {
    for column in 0...3 {
        addKey(keys, column: column, row: row)
    }
}
addKey(keys, column: 1, row: 3, columns: 2)
addKey(keys, column: 3, row: 3)
context.addPath(keys)
context.fillPath()

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
