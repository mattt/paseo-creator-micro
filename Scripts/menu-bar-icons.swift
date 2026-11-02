// Run from the repository root with Xcode's Swift toolchain:
// swift Scripts/menu-bar-icons.swift [preview-directory]
// Regenerates the bundled template PDFs and renders them on light and dark backgrounds.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let resources = URL(fileURLWithPath: "Sources/PaseoMicro/Resources", isDirectory: true)
let previews = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "/tmp/paseo-micro-icons")
try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: previews, withIntermediateDirectories: true)

func roundedRect(_ context: CGContext, _ rect: CGRect, radius: CGFloat) {
    context.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
    context.fillPath()
}

func drawKeypad(_ context: CGContext, state: String) {
    // A 15-point silhouette on whole-point edges keeps the keys clear at 1x and 2x.
    context.saveGState()
    context.translateBy(x: 0, y: 18)
    context.scaleBy(x: 1, y: -1)
    context.setFillColor(gray: 0, alpha: 1)
    for (x, y, width) in [
        (5, 2, 3), (9, 2, 3),
        (1, 6, 3), (5, 6, 3), (9, 6, 3), (13, 6, 3),
        (1, 10, 3), (5, 10, 3), (9, 10, 3), (13, 10, 3),
        (5, 14, 7), (13, 14, 3),
    ] {
        roundedRect(context, CGRect(x: x, y: y, width: width, height: 3), radius: 0.5)
    }
    // The curved side faces upper left; center its bounds in the 3-point grid slot.
    let radius: CGFloat = 1.5
    let offset = radius * (1 - 1 / sqrt(2)) / 2
    context.saveGState()
    context.translateBy(x: 2.5 + offset, y: 3.5 + offset)
    context.rotate(by: -.pi / 4)
    context.addArc(center: .zero, radius: radius, startAngle: .pi, endAngle: 2 * .pi, clockwise: false)
    context.closePath()
    context.fillPath()
    context.restoreGState()
    context.addPath(
        CGPath(
            roundedRect: CGRect(x: 13, y: 2, width: 3, height: 3),
            cornerWidth: 0.5,
            cornerHeight: 0.5,
            transform: nil
        )
    )
    context.addEllipse(in: CGRect(x: 14, y: 3, width: 1, height: 1))
    context.drawPath(using: .eoFill)
    if state == "attention" {
        roundedRect(context, CGRect(x: 20, y: 7, width: 2, height: 5), radius: 0.5)
        context.fillEllipse(in: CGRect(x: 20, y: 13, width: 2, height: 2))
    }
    context.restoreGState()
}

for state in ["connected", "disconnected", "attention"] {
    let resourceState = state == "disconnected" ? "connected" : state
    let url = resources.appendingPathComponent("Keypad-\(resourceState).pdf")
    var mediaBox = CGRect(x: 0, y: 0, width: 24, height: 18)
    if state != "disconnected" {
        let pdf = CGContext(url as CFURL, mediaBox: &mediaBox, nil)!
        pdf.beginPDFPage(nil)
        drawKeypad(pdf, state: state)
        pdf.endPDFPage()
        pdf.closePDF()
    }

    // Render the actual PDF resource, rather than a second copy of its drawing code.
    let page = CGPDFDocument(url as CFURL)!.page(at: 1)!
    for dark in [false, true] {
        for scale in [1, 2] {
            let context = CGContext(
                data: nil,
                width: 40 * scale,
                height: 28 * scale,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )!
            context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
            context.setFillColor(gray: dark ? 0.12 : 0.96, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: 40, height: 28))
            context.translateBy(x: 8, y: 5)
            context.setAlpha(state == "disconnected" ? 0.4 : 1)
            if dark {
                context.beginTransparencyLayer(auxiliaryInfo: nil)
                context.drawPDFPage(page)
                context.setBlendMode(.sourceIn)
                context.setFillColor(gray: 1, alpha: 1)
                context.fill(mediaBox)
                context.endTransparencyLayer()
            } else {
                context.drawPDFPage(page)
            }
            let name = "menu-\(state)-\(dark ? "dark" : "light")-\(scale)x.png"
            let destination = CGImageDestinationCreateWithURL(
                previews.appendingPathComponent(name) as CFURL,
                UTType.png.identifier as CFString,
                1,
                nil
            )!
            CGImageDestinationAddImage(destination, context.makeImage()!, nil)
            precondition(CGImageDestinationFinalize(destination))
        }
    }
}
