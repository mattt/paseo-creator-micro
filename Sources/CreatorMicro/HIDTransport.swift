import Foundation
import IOKit
import IOKit.hid

/// The transport for a real keypad, through IOKit's HID manager.
///
/// The transport matches the keypad's vendor collection (usage page `0xFF00`),
/// opens it without seizing it, so that other programs keep their access,
/// and reports each arrival and removal, so that a session can reconnect
/// after an unplug, a replug, or sleep.
/// It needs no Input Monitoring permission.
///
/// All IOKit work and all mutable state stay on one serial dispatch queue.
public final class HIDTransport: KeypadTransport, @unchecked Sendable {
    /// Work Louder's USB vendor identifier.
    public static let vendorID = 0x303A

    /// The USB product identifiers of the Creator Micro 2.
    public static let productIDs: Set<Int> = [0x8298, 0x8297]

    /// The usage page of the vendor collection that carries JSON-RPC.
    public static let vendorUsagePage = 0xFF00

    // The C callbacks reach the transport through this box,
    // which the manager retains until its cancel handler runs.
    // `transport` is set once in `init` and never reassigned;
    // it is a `var` because Swift 6.2 does not accept `weak let`.
    private final class Box: @unchecked Sendable {
        weak var transport: HIDTransport?
        init(_ transport: HIDTransport) { self.transport = transport }
    }

    private let queue = DispatchQueue(label: "co.dododo.paseo-micro.hid")
    private let productIDs: Set<Int>
    // Accessed only on `queue`.
    private var manager: IOHIDManager?
    private var device: IOHIDDevice?
    private var handler: (@Sendable (KeypadTransportEvent) -> Void)?

    /// Creates a transport for the Creator Micro 2.
    ///
    /// - Parameter productIDs: The product identifiers to accept.
    public init(productIDs: Set<Int> = HIDTransport.productIDs) {
        self.productIDs = productIDs
    }

    // MARK: - KeypadTransport

    public func start(_ handler: @escaping @Sendable (KeypadTransportEvent) -> Void) {
        queue.async { [self] in
            guard self.manager == nil else { return }
            let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
            let matching: [String: Any] = [
                kIOHIDVendorIDKey: Self.vendorID,
                kIOHIDDeviceUsagePageKey: Self.vendorUsagePage,
            ]
            IOHIDManagerSetDeviceMatching(manager, matching as CFDictionary)
            let context = Unmanaged.passRetained(Box(self))
            let pointer = context.toOpaque()
            IOHIDManagerRegisterDeviceMatchingCallback(manager, Self.matchingCallback, pointer)
            IOHIDManagerRegisterDeviceRemovalCallback(manager, Self.removalCallback, pointer)
            IOHIDManagerRegisterInputReportCallback(manager, Self.reportCallback, pointer)
            IOHIDManagerSetDispatchQueue(manager, queue)
            IOHIDManagerSetCancelHandler(manager) { context.release() }
            self.manager = manager
            self.handler = handler
            // Open without seizing: the vendor collection shares a device with a keyboard.
            IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
            IOHIDManagerActivate(manager)
        }
    }

    public func stop() {
        queue.async { [self] in
            guard let manager else { return }
            let hadDevice = device != nil
            let handler = handler
            self.manager = nil
            self.device = nil
            self.handler = nil
            IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
            IOHIDManagerCancel(manager)
            if hadDevice { handler?(.disconnected) }
        }
    }

    public func send(_ reports: [[UInt8]]) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            queue.async { [self] in
                guard let device else {
                    continuation.resume(throwing: KeypadError.notConnected)
                    return
                }
                for report in reports {
                    let result = report.withUnsafeBufferPointer { buffer in
                        IOHIDDeviceSetReport(
                            device,
                            kIOHIDReportTypeOutput,
                            CFIndex(report.first ?? Report.id),
                            buffer.baseAddress!,
                            buffer.count
                        )
                    }
                    guard result == kIOReturnSuccess else {
                        continuation.resume(throwing: KeypadError.sendFailed(result))
                        return
                    }
                }
                continuation.resume()
            }
        }
    }

    // MARK: - Callbacks (on `queue`)

    private func matched(_ device: IOHIDDevice) {
        guard Self.hasVendorCollection(device),
            let productID = Self.property(device, kIOHIDProductIDKey) as Int?,
            productIDs.contains(productID)
        else { return }
        guard self.device == nil else { return }
        self.device = device
        let info = KeypadDevice(
            productID: productID,
            product: Self.property(device, kIOHIDProductKey) ?? "Creator Micro 2",
            transport: Self.property(device, kIOHIDTransportKey) ?? "USB"
        )
        handler?(.connected(info))
    }

    private func removed(_ device: IOHIDDevice) {
        guard let current = self.device, CFEqual(current, device) else { return }
        self.device = nil
        handler?(.disconnected)
    }

    private func received(_ report: UnsafeMutablePointer<UInt8>, length: Int, from sender: UnsafeMutableRawPointer?) {
        guard let current = device, let sender, Unmanaged.passUnretained(current).toOpaque() == sender,
            let handler, length > 0
        else { return }
        handler(.report(Array(UnsafeBufferPointer(start: report, count: length))))
    }

    private static let matchingCallback: IOHIDDeviceCallback = { context, _, _, device in
        guard let context else { return }
        Unmanaged<Box>.fromOpaque(context).takeUnretainedValue().transport?.matched(device)
    }

    private static let removalCallback: IOHIDDeviceCallback = { context, _, _, device in
        guard let context else { return }
        Unmanaged<Box>.fromOpaque(context).takeUnretainedValue().transport?.removed(device)
    }

    private static let reportCallback: IOHIDReportCallback = { context, _, sender, _, _, report, length in
        guard let context else { return }
        Unmanaged<Box>.fromOpaque(context).takeUnretainedValue().transport?.received(
            report,
            length: length,
            from: sender
        )
    }

    // MARK: - Device properties

    private static func hasVendorCollection(_ device: IOHIDDevice) -> Bool {
        let pairs = IOHIDDeviceGetProperty(device, kIOHIDDeviceUsagePairsKey as CFString) as? [[String: Any]] ?? []
        return pairs.contains { ($0[kIOHIDDeviceUsagePageKey] as? Int) == vendorUsagePage }
    }

    private static func property<T>(_ device: IOHIDDevice, _ key: String) -> T? {
        IOHIDDeviceGetProperty(device, key as CFString) as? T
    }
}
