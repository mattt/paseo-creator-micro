/// A description of a connected keypad.
public struct KeypadDevice: Sendable, Hashable, Codable {
    /// The USB product identifier, such as `0x8298`.
    public var productID: Int
    /// The product name that the device reports.
    public var product: String
    /// The connection, such as `USB`, `Bluetooth Low Energy`, or `Emulated`.
    public var transport: String

    /// Creates a device description.
    ///
    /// - Parameters:
    ///   - productID: The USB product identifier.
    ///   - product: The product name.
    ///   - transport: The connection.
    public init(productID: Int, product: String, transport: String) {
        self.productID = productID
        self.product = product
        self.transport = transport
    }
}

/// An event from a keypad transport.
public enum KeypadTransportEvent: Sendable, Hashable {
    /// A keypad became available.
    case connected(KeypadDevice)
    /// The keypad went away, for example because it was unplugged.
    case disconnected
    /// The keypad sent an input report, starting with the report ID.
    case report([UInt8])
}

/// A connection to the keypad's vendor HID interface, at the level of 64-byte reports.
///
/// A transport finds the keypad, reports when it comes and goes,
/// and moves reports in both directions.
/// ``KeypadClient`` adds JSON-RPC on top.
public protocol KeypadTransport: Sendable {
    /// Starts looking for the keypad and delivers events to a handler.
    ///
    /// The transport calls the handler serially, in order,
    /// on a queue of its choice.
    /// If a keypad is present, the first event is ``KeypadTransportEvent/connected(_:)``.
    ///
    /// - Parameter handler: The function that receives events until ``stop()``.
    func start(_ handler: @escaping @Sendable (KeypadTransportEvent) -> Void)

    /// Stops the transport and releases the keypad.
    func stop()

    /// Sends the output reports of one message, in order.
    ///
    /// The transport sends the reports of one call before the reports of the next,
    /// so that messages from concurrent callers do not interleave.
    ///
    /// - Parameter reports: The reports, each starting with the report ID.
    /// - Throws: ``KeypadError/notConnected`` if no keypad is connected,
    ///   or ``KeypadError/sendFailed(_:)`` if the system rejects a report.
    func send(_ reports: [[UInt8]]) async throws
}

/// Errors from the keypad library.
public enum KeypadError: Error, Sendable, Hashable {
    /// No keypad is connected.
    case notConnected
    /// The system rejected an output report, with the given IOKit return code.
    case sendFailed(Int32)
    /// No reply arrived in time for the method.
    case timeout(method: String)
    /// The keypad went away before it replied to the method.
    case disconnected(method: String)
    /// The keypad replied with an error.
    case remote(method: String, error: JSONValue)
    /// The library refuses the method, because it would write the keypad's files.
    case forbiddenMethod(String)
    /// All 999 request identifiers are in use.
    case tooManyRequests
    /// The reply did not have the expected form.
    case unexpectedReply(method: String, reply: JSONValue?)
    /// An event stream's reader fell so far behind that the stream's buffer filled;
    /// the stream delivered the events before the overflow and ended.
    case eventsOverflowed
}

extension KeypadError: CustomStringConvertible {
    public var description: String {
        switch self {
        case .notConnected: "No keypad is connected"
        case .sendFailed(let code):
            "The system rejected a report (IOReturn 0x\(String(UInt32(bitPattern: code), radix: 16)))"
        case .timeout(let method): "No reply to \(method) in time"
        case .disconnected(let method): "The keypad went away before it replied to \(method)"
        case .remote(let method, let error): "\(method) failed: \(error.jsonString)"
        case .forbiddenMethod(let method): "\(method) writes the keypad's files, which this library never does"
        case .tooManyRequests: "Too many requests wait for replies"
        case .unexpectedReply(let method, let reply): "Unexpected reply to \(method): \(reply?.jsonString ?? "none")"
        case .eventsOverflowed: "The keypad's events arrived faster than they were read, and the stream ended"
        }
    }
}
