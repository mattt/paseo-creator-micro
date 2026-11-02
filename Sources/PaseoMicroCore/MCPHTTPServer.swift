import Foundation
import MCP
import NIOCore
import NIOHTTP1
import NIOPosix

/// The app's MCP server: Streamable HTTP, stateless, on the loopback interface.
///
/// Each POST to the endpoint gets a fresh MCP server and `StatelessHTTPServerTransport`,
/// so that any number of clients can initialize and call tools.
/// The transport checks the `Host` and `Origin` headers against DNS rebinding.
///
/// ```swift
/// let mcp = try await MCPHTTPServer.bind(port: MCPHTTPServer.defaultPort, tools: tools)
/// print(mcp.url)  // http://127.0.0.1:7655/mcp
/// try await mcp.run()
/// ```
public final class MCPHTTPServer: Sendable {
    /// The default port.
    public static let defaultPort = 7655

    /// The endpoint path.
    public static let endpoint = "/mcp"

    /// The largest request body accepted, in bytes.
    public static let maximumBodySize = 1024 * 1024

    /// The address the server listens on.
    public let host: String

    /// The port the server listens on; with port 0, the port that the system chose.
    public let port: Int

    /// The server's version, in the MCP `initialize` reply.
    public let version: String

    private typealias Connection = NIOAsyncChannel<HTTPServerRequestPart, HTTPServerResponsePart>

    private let serverChannel: NIOAsyncChannel<Connection, Never>
    private let tools: KeypadTools
    private let connections = ConnectionSet()

    private init(
        host: String,
        port: Int,
        version: String,
        serverChannel: NIOAsyncChannel<Connection, Never>,
        tools: KeypadTools
    ) {
        self.host = host
        self.port = port
        self.version = version
        self.serverChannel = serverChannel
        self.tools = tools
    }

    /// The endpoint's URL, such as `http://127.0.0.1:7655/mcp`.
    public var url: URL {
        URL(string: "http://\(host):\(port)\(Self.endpoint)")!
    }

    /// Binds the server to the loopback interface.
    ///
    /// - Parameters:
    ///   - host: The address; keep the default, `127.0.0.1`, so that only this Mac can connect.
    ///   - port: The port, or 0 for one that the system chooses.
    ///   - version: The server's version.
    ///   - tools: The tools that the server offers.
    /// - Returns: The listening server; call ``run()`` to accept connections.
    /// - Throws: A system error, for example when the port is busy.
    public static func bind(
        host: String = "127.0.0.1",
        port: Int = defaultPort,
        version: String = paseoMicroVersion,
        tools: KeypadTools
    ) async throws -> MCPHTTPServer {
        let channel = try await ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton)
            .serverChannelOption(.socketOption(.so_reuseaddr), value: 1)
            .bind(host: host, port: port) { channel in
                // Pipelining assistance stops reading while a request is in progress,
                // so a client that disconnects during a long tool call would go unnoticed.
                // `serve` answers one request at a time, in order, without it.
                channel.pipeline.configureHTTPServerPipeline(withPipeliningAssistance: false).flatMapThrowing {
                    try Connection(wrappingChannelSynchronously: channel)
                }
            }
        let boundPort = channel.channel.localAddress?.port ?? port
        return MCPHTTPServer(host: host, port: boundPort, version: version, serverChannel: channel, tools: tools)
    }

    /// Accepts connections until the task is canceled or ``close()`` is called.
    ///
    /// When it stops, it closes every connection, cancels the tool calls in progress,
    /// such as a `wait_for_input` call or a lighting call that waits for the keypad,
    /// and waits for them to end.
    /// A connection that closes also cancels its own tool calls.
    ///
    /// - Throws: A system error if accepting fails.
    public func run() async throws {
        defer { close() }
        try await withTaskCancellationHandler {
            try await serverChannel.executeThenClose { inbound in
                try await withThrowingDiscardingTaskGroup { group in
                    for try await connection in inbound {
                        group.addTask { await self.serve(connection) }
                    }
                    self.connections.closeAll()
                    group.cancelAll()
                }
            }
        } onCancel: {
            close()
        }
    }

    /// Stops accepting connections and closes every connection; ``run()`` then returns.
    public func close() {
        serverChannel.channel.close(promise: nil)
        connections.closeAll()
    }

    // MARK: - HTTP

    private func serve(_ connection: Connection) async {
        guard connections.insert(connection.channel) else { return }
        defer { connections.remove(connection.channel) }
        let calls = ToolCalls()
        connection.channel.closeFuture.whenComplete { _ in calls.cancel() }
        await withTaskCancellationHandler {
            await serve(connection, calls: calls)
        } onCancel: {
            calls.cancel()
        }
        calls.cancel()
        await calls.wait()
    }

    private func serve(_ connection: Connection, calls: ToolCalls) async {
        try? await connection.executeThenClose { inbound, outbound in
            var head: HTTPRequestHead?
            var body = ByteBuffer()
            var tooLarge = false
            for try await part in inbound {
                switch part {
                case .head(let requestHead):
                    head = requestHead
                    body.clear()
                    tooLarge = false
                case .body(var chunk):
                    if body.readableBytes + chunk.readableBytes > Self.maximumBodySize {
                        tooLarge = true
                    } else {
                        body.writeBuffer(&chunk)
                    }
                case .end:
                    guard let requestHead = head else { continue }
                    head = nil
                    let response: HTTPResponse
                    if tooLarge {
                        response = .error(statusCode: 413, .invalidRequest("Payload Too Large"))
                    } else {
                        response = await self.respond(to: requestHead, body: body, calls: calls)
                    }
                    try await Self.write(response, for: requestHead, to: outbound)
                    if !requestHead.isKeepAlive { return }
                }
            }
        }
    }

    private func respond(to head: HTTPRequestHead, body: ByteBuffer, calls: ToolCalls) async -> HTTPResponse {
        let path = head.uri.split(separator: "?", maxSplits: 1).first.map(String.init) ?? head.uri
        guard path == Self.endpoint else {
            return .error(statusCode: 404, .invalidRequest("Not Found"))
        }
        // Header names are case-insensitive: combine duplicates under one lowercase name,
        // so that a second Host or Origin in another case cannot hide from the validators.
        var headers: [String: String] = [:]
        for (name, value) in head.headers {
            let name = name.lowercased()
            headers[name] = headers[name].map { "\($0), \(value)" } ?? value
        }
        let request = HTTPRequest(
            method: head.method.rawValue,
            headers: headers,
            body: body.readableBytes > 0 ? Data(body.readableBytesView) : nil,
            path: path
        )
        let transport = StatelessHTTPServerTransport(
            validationPipeline: StandardValidationPipeline(validators: [
                OriginValidator.localhost(port: port),
                AcceptHeaderValidator(mode: .jsonOnly),
                ContentTypeValidator(),
                ProtocolVersionValidator(),
            ])
        )
        let server = Server(
            name: "paseo-micro",
            version: version,
            title: "Paseo Micro",
            instructions: "Read the Creator Micro 2 keypad and control its lights.",
            capabilities: .init(tools: .init(listChanged: false))
        )
        await tools.register(on: server, running: calls.run)
        do {
            try await server.start(transport: transport)
        } catch {
            return .error(statusCode: 500, .internalError("Could not start the MCP server"))
        }
        // The SDK runs tool handlers in tasks of its own, which cancellation does not reach:
        // `serve` cancels the tool's work through `calls`,
        // and stopping the server disconnects the transport, which ends the waiting request.
        let response = await withTaskCancellationHandler {
            await transport.handleRequest(request)
        } onCancel: {
            Task { await server.stop() }
        }
        await server.stop()
        return response
    }

    private static func write(
        _ response: HTTPResponse,
        for request: HTTPRequestHead,
        to outbound: NIOAsyncChannelOutboundWriter<HTTPServerResponsePart>
    ) async throws {
        var head = HTTPResponseHead(
            version: request.version,
            status: HTTPResponseStatus(statusCode: response.statusCode)
        )
        for (name, value) in response.headers {
            head.headers.add(name: name, value: value)
        }
        if case .stream(let stream, _) = response {
            try await outbound.write(.head(head))
            for try await chunk in stream {
                try await outbound.write(.body(.byteBuffer(ByteBuffer(bytes: chunk))))
            }
        } else {
            let body = response.bodyData ?? Data()
            head.headers.replaceOrAdd(name: "Content-Length", value: String(body.count))
            if !request.isKeepAlive { head.headers.replaceOrAdd(name: "Connection", value: "close") }
            try await outbound.write(.head(head))
            if !body.isEmpty {
                try await outbound.write(.body(.byteBuffer(ByteBuffer(bytes: body))))
            }
        }
        try await outbound.write(.end(nil))
    }
}
