import CoreGraphics
import CreatorMicro
import Darwin
import Foundation
import PaseoMicroCore
import Synchronization

/// Waits until a condition holds, polling every 10 milliseconds.
func eventually(
    timeout: Duration = .seconds(3),
    _ condition: @Sendable () async -> Bool
) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return await condition()
}

/// Returns whether a task finishes within a time limit; the task keeps running if it does not.
func finishes<Success: Sendable, Failure: Error>(
    _ task: Task<Success, Failure>,
    within timeout: Duration = .seconds(2)
) async -> Bool {
    let done = Mutex(false)
    let watcher = Task {
        _ = await task.result
        done.withLock { $0 = true }
    }
    defer { watcher.cancel() }
    return await eventually(timeout: timeout) { done.withLock { $0 } }
}

/// Creates a socket file on which nothing listens, as a crashed server leaves behind.
func makeStaleSocket(at path: String) throws {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(.EIO) }
    defer { close(fd) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8.prefix($0.count - 1)) }
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard result == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
}

/// Connects to a Unix domain socket and returns the descriptor, without reading from it.
func connectUnix(path: String) throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(.EIO) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8.prefix($0.count - 1)) }
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard result == 0 else {
        close(fd)
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    return fd
}

/// Creates the folder of a temporary socket path with mode 0700.
func makeSocketFolder(for path: String, mode: Int = 0o700) throws -> String {
    let folder = URL(fileURLWithPath: path).deletingLastPathComponent().path
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: folder)
    return folder
}

/// Opens a TCP connection to a port on the loopback interface and returns its descriptor.
func connectLoopback(port: Int) throws -> Int32 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(.EIO) }
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(UInt16(port).bigEndian)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard result == 0 else {
        close(fd)
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    return fd
}

/// Starts a session on an emulated keypad with a fast poll.
func startSession(
    _ keypad: EmulatedKeypad,
    pollInterval: Duration = .milliseconds(50),
    keymapRefreshInterval: Duration = .seconds(60),
    repaintInterval: Duration = KeypadSession.chatGPTRepaintInterval
) async -> KeypadSession {
    let session = KeypadSession(
        transport: keypad,
        pollInterval: pollInterval,
        requestTimeout: .seconds(1),
        keymapRefreshInterval: keymapRefreshInterval,
        repaintInterval: repaintInterval
    )
    await session.start()
    return session
}

/// A short, unique socket path in the temporary folder.
func temporarySocketPath() -> String {
    let folder = URL(fileURLWithPath: "/tmp", isDirectory: true)
        .appending(path: "pm-\(UUID().uuidString.prefix(8))", directoryHint: .isDirectory)
    return folder.appending(path: "bridge.sock").path
}

/// An interface driver that records calls instead of opening URLs or posting events.
///
/// An activated app comes to the front after a delay, as a real app does,
/// or never, when the delay is `nil`.
final class RecordingInterface: InterfaceDriver {
    enum Call: Equatable, Sendable {
        case open(URL)
        case activate(String)
        /// A posted shortcut and the app that was frontmost when it went out.
        case post(String, frontmost: String?)
        /// A posted scroll: its wheel value, its point, its window, and the frontmost app.
        case scroll(wheel: Int32, at: CGPoint, window: Int, frontmost: String?)
    }

    private struct State {
        var trusted: Bool
        var frontmost: String?
        var windows: [String: AppWindow]
        var calls: [Call] = []
        var pointer = RecordingInterface.home
        var pointerMoves: [CGPoint] = []
        var scrollTimes: [ContinuousClock.Instant] = []
    }

    /// Where the pointer starts.
    static let home = CGPoint(x: 3, y: 4)

    private let state: Mutex<State>
    private let activationDelay: Duration?

    /// Creates the driver. `windows` holds each app's frontmost window, by bundle ID.
    init(
        trusted: Bool = true,
        frontmost: String? = nil,
        windows: [String: AppWindow] = [:],
        activationDelay: Duration? = .milliseconds(30)
    ) {
        state = Mutex(State(trusted: trusted, frontmost: frontmost, windows: windows))
        self.activationDelay = activationDelay
    }

    var calls: [Call] { state.withLock { $0.calls } }

    /// Where the pointer is now.
    var pointer: CGPoint { state.withLock { $0.pointer } }

    /// The points to which the pointer moved, in order.
    var pointerMoves: [CGPoint] { state.withLock { $0.pointerMoves } }

    /// When each scroll event went out.
    var scrollTimes: [ContinuousClock.Instant] { state.withLock { $0.scrollTimes } }

    /// The wheel values of the posted scroll events.
    var scrollWheels: [Int32] {
        calls.compactMap { if case .scroll(let wheel, _, _, _) = $0 { wheel } else { nil } }
    }

    func isAccessibilityTrusted() async -> Bool { state.withLock { $0.trusted } }

    func open(_ url: URL) async throws { state.withLock { $0.calls.append(.open(url)) } }

    func activate(bundleIdentifier: String) async throws {
        state.withLock { $0.calls.append(.activate(bundleIdentifier)) }
        guard let activationDelay else { return }
        Task {
            try? await Task.sleep(for: activationDelay)
            state.withLock { $0.frontmost = bundleIdentifier }
        }
    }

    func frontmostBundleIdentifier() async -> String? { state.withLock { $0.frontmost } }

    func post(_ shortcut: Shortcut) async throws {
        state.withLock { state in
            let frontmost = state.frontmost
            state.calls.append(.post(shortcut.description, frontmost: frontmost))
        }
    }

    func frontWindow(bundleIdentifier: String) async throws -> AppWindow {
        guard let window = state.withLock({ $0.windows[bundleIdentifier] }) else {
            throw InterfaceError.noWindow(bundleIdentifier)
        }
        return window
    }

    func movePointer(to point: CGPoint) async -> CGPoint {
        state.withLock { state in
            let saved = state.pointer
            state.pointer = point
            state.pointerMoves.append(point)
            return saved
        }
    }

    func postScroll(lines: Int, at point: CGPoint, in window: AppWindow) async throws {
        state.withLock { state in
            let frontmost = state.frontmost
            state.scrollTimes.append(.now)
            state.calls.append(
                .scroll(
                    wheel: ScrollRequest.wheelDelta(lines: lines),
                    at: point,
                    window: window.windowNumber,
                    frontmost: frontmost
                )
            )
        }
    }
}

/// The inputs of a key tap: a press, then a release.
func tapInputs(key: Int) -> [KeypadInput] {
    [.key(KeyInput(key: key, action: .press)), .key(KeyInput(key: key, action: .release))]
}

/// Reads a number of inputs from a client's events.
func readInputs(from events: AsyncThrowingStream<KeypadEvent, any Error>, count: Int) async throws -> [KeypadInput] {
    var inputs: [KeypadInput] = []
    for try await event in events {
        guard case .input(let input) = event else { continue }
        inputs.append(input)
        if inputs.count == count { break }
    }
    return inputs
}
