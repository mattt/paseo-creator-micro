/// The 64-byte HID reports that carry the keypad's vendor protocol.
///
/// Each report holds the report ID `0x06`, a channel, a payload length of at most 61,
/// and that many bytes of UTF-8 text, padded with zeros.
/// A message longer than one payload spans several reports.
public enum Report {
    /// The report ID of every vendor report.
    public static let id: UInt8 = 0x06

    /// The size of a report in bytes, including the report ID.
    public static let size = 64

    /// The largest payload that one report carries.
    public static let maxPayload = 61

    /// A logical stream inside the vendor reports.
    public enum Channel: UInt8, Sendable, Hashable, CaseIterable {
        /// Debug text from the firmware.
        case debug = 1
        /// JSON-RPC requests, replies, and notifications.
        case rpc = 2
    }

    /// One decoded report: its channel and its payload bytes.
    public struct Frame: Sendable, Hashable {
        /// The channel that the report belongs to.
        public var channel: Channel
        /// The payload bytes, without padding.
        public var payload: [UInt8]

        /// Creates a frame.
        ///
        /// - Parameters:
        ///   - channel: The channel that the report belongs to.
        ///   - payload: The payload bytes; at most ``Report/maxPayload``.
        public init(channel: Channel, payload: [UInt8]) {
            self.channel = channel
            self.payload = payload
        }

        /// Decodes a frame from the bytes of an input or output report.
        ///
        /// - Parameter report: The report bytes, starting with the report ID.
        /// - Returns: The frame, or `nil` if the report is too short,
        ///   has another report ID or an unknown channel,
        ///   or claims more payload than it holds.
        public init?(report: [UInt8]) {
            guard report.count >= 3, report[0] == Report.id,
                let channel = Channel(rawValue: report[1])
            else { return nil }
            let count = Int(report[2])
            guard count <= Report.maxPayload, 3 + count <= report.count else { return nil }
            self.channel = channel
            self.payload = Array(report[3 ..< 3 + count])
        }

        /// The 64 bytes of the report for this frame.
        public var report: [UInt8] {
            var bytes = [UInt8](repeating: 0, count: Report.size)
            bytes[0] = Report.id
            bytes[1] = channel.rawValue
            let count = min(payload.count, Report.maxPayload)
            bytes[2] = UInt8(count)
            bytes.replaceSubrange(3 ..< 3 + count, with: payload.prefix(count))
            return bytes
        }
    }

    /// Splits a message into 64-byte reports.
    ///
    /// The bytes go out as they are; callers add any delimiters.
    /// A multibyte UTF-8 character may span two reports;
    /// ``MessageReassembler`` joins bytes before it decodes text.
    ///
    /// - Parameters:
    ///   - message: The bytes to send.
    ///   - channel: The channel for every report.
    /// - Returns: The reports, each ``Report/size`` bytes long.
    public static func reports(for message: some Collection<UInt8>, channel: Channel = .rpc) -> [[UInt8]] {
        let bytes = Array(message)
        return stride(from: 0, to: bytes.count, by: maxPayload).map { start in
            let end = min(start + maxPayload, bytes.count)
            return Frame(channel: channel, payload: Array(bytes[start ..< end])).report
        }
    }

    /// Splits a JSON-RPC message into reports, wrapped in `"\r\n"` as the firmware expects.
    ///
    /// - Parameter json: The UTF-8 bytes of one JSON object.
    /// - Returns: The reports on the JSON-RPC channel.
    public static func rpcReports(for json: some Collection<UInt8>) -> [[UInt8]] {
        reports(for: Array("\r\n".utf8) + Array(json) + Array("\r\n".utf8), channel: .rpc)
    }
}

/// Reassembles JSON objects from a stream of report payloads.
///
/// The firmware does not mark message boundaries,
/// so the reassembler counts braces outside strings,
/// and returns each top-level object when its closing brace arrives.
/// Bytes between objects, such as `"\r\n"`, are dropped.
public struct MessageReassembler: Sendable {
    /// The largest number of bytes that the reassembler holds for one unfinished object.
    ///
    /// When an object grows past this limit, the reassembler discards it
    /// and starts again at the next opening brace.
    public var limit: Int

    private var buffer: [UInt8] = []
    private var depth = 0
    private var inString = false
    private var escaped = false

    /// Creates an empty reassembler.
    ///
    /// - Parameter limit: The largest unfinished object, in bytes.
    public init(limit: Int = 64 * 1024) {
        self.limit = limit
    }

    /// Whether the reassembler holds part of an object.
    public var isEmpty: Bool { buffer.isEmpty }

    /// Adds bytes and returns the objects that they complete.
    ///
    /// - Parameter bytes: The next payload bytes from the stream.
    /// - Returns: The UTF-8 bytes of each complete top-level object, in order.
    public mutating func append(_ bytes: some Sequence<UInt8>) -> [[UInt8]] {
        var messages: [[UInt8]] = []
        for byte in bytes {
            if depth == 0 {
                // Outside an object, only an opening brace matters.
                guard byte == UInt8(ascii: "{") else { continue }
                buffer = [byte]
                depth = 1
                inString = false
                escaped = false
                continue
            }
            buffer.append(byte)
            if inString {
                if escaped {
                    escaped = false
                } else if byte == UInt8(ascii: "\\") {
                    escaped = true
                } else if byte == UInt8(ascii: "\"") {
                    inString = false
                }
            } else if byte == UInt8(ascii: "\"") {
                inString = true
            } else if byte == UInt8(ascii: "{") {
                depth += 1
            } else if byte == UInt8(ascii: "}") {
                depth -= 1
                if depth == 0 {
                    messages.append(buffer)
                    buffer = []
                }
            }
            if buffer.count > limit {
                reset()
            }
        }
        return messages
    }

    /// Discards any unfinished object.
    public mutating func reset() {
        buffer = []
        depth = 0
        inString = false
        escaped = false
    }
}
