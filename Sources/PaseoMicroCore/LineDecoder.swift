import NIOCore

/// Splits a byte stream into newline-terminated lines, without the newline.
struct LineDecoder: ByteToMessageDecoder {
    typealias InboundOut = ByteBuffer

    /// The longest line accepted; a longer line closes the connection.
    static let maximumLength = 1024 * 1024

    struct LineTooLong: Error {}

    mutating func decode(context: ChannelHandlerContext, buffer: inout ByteBuffer) throws -> DecodingState {
        guard let newline = buffer.readableBytesView.firstIndex(of: UInt8(ascii: "\n")) else {
            if buffer.readableBytes > Self.maximumLength { throw LineTooLong() }
            return .needMoreData
        }
        let length = newline - buffer.readerIndex
        if length > Self.maximumLength { throw LineTooLong() }
        var line = buffer.readSlice(length: length)!
        buffer.moveReaderIndex(forwardBy: 1)
        // Accept CRLF as well as LF.
        if line.readableBytesView.last == UInt8(ascii: "\r") {
            line = line.getSlice(at: line.readerIndex, length: line.readableBytes - 1)!
        }
        context.fireChannelRead(Self.wrapInboundOut(line))
        return .continue
    }

    mutating func decodeLast(context: ChannelHandlerContext, buffer: inout ByteBuffer, seenEOF: Bool) throws
        -> DecodingState
    {
        while try decode(context: context, buffer: &buffer) == .continue {}
        return .needMoreData
    }
}
