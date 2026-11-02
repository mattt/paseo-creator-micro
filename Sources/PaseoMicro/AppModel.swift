import AppKit
import CreatorMicro
import Observation
import PaseoMicroCore

/// The app's state, for the menu.
///
/// The model owns the keypad session, the bridge server, and the MCP server,
/// and mirrors their state on the main actor.
@MainActor
@Observable
final class AppModel {
    /// The keypad's state.
    private(set) var keypad = KeypadState.disconnected
    /// The lights that the app keeps on the keypad.
    private(set) var lights = DesiredLights()
    /// The most recent input.
    private(set) var lastInput: KeypadInput?
    /// The bridge's clients.
    private(set) var bridgeClients: [BridgeClientInfo] = []
    /// The bridge's socket path, once it listens.
    private(set) var bridgePath: String?
    /// Why the bridge does not listen, if it failed.
    private(set) var bridgeError: String?
    /// The MCP endpoint, once it listens.
    private(set) var mcpURL: URL?
    /// Why the MCP server does not listen, if it failed.
    private(set) var mcpError: String?
    /// Whether the ChatGPT app runs, whether or not it can reach the keypad.
    private(set) var chatGPTRunning = false
    /// Whether the app has the Accessibility permission, which `sendShortcut` and `scroll` need.
    private(set) var accessibilityTrusted = false
    /// Why Escape cannot close the radial menu, after the app failed to install its keyboard tap.
    private(set) var escapeTapProblem: EscapeTapProblem?
    /// The emulated keypad, when the app uses one.
    private(set) var emulator: EmulatedKeypad?
    /// The app's login item.
    let launchAtLogin = LaunchAtLogin()

    /// Whether the emulated keypad is forced by the `PASEO_MICRO_EMULATED` environment variable.
    let emulationForced: Bool

    /// Whether the app uses the emulated keypad.
    var usesEmulator: Bool {
        get { emulationForced || UserDefaults.standard.bool(forKey: Self.emulatorKey) }
        set {
            guard !emulationForced, newValue != usesEmulator else { return }
            UserDefaults.standard.set(newValue, forKey: Self.emulatorKey)
            Task { await restart() }
        }
    }

    private static let emulatorKey = "useEmulatedKeypad"
    private static let portKey = "mcpPort"

    private var session: KeypadSession?
    private var bridge: BridgeServer?
    private let radialMenu = RadialMenuOverlay()
    /// Drops Escape while the radial menu shows, and cancels the menu instead.
    @ObservationIgnored
    private lazy var escapeTap = EscapeKeyTap(
        onEscape: { [weak self] in self?.bridge?.radialMenu.cancel() },
        onProblem: { [weak self] problem in self?.escapeTapProblem = problem }
    )
    /// The plugin's selected workspace, kept across bridge restarts while the app runs.
    private let selection = SelectionStore()
    private var mcp: MCPHTTPServer?
    private var tasks: [Task<Void, Never>] = []
    private var servers: [Task<Void, Never>] = []
    private var observers: [any NSObjectProtocol] = []
    private var restarting = false
    private var chatGPT = ChatGPTProcesses()
    /// What the session last heard about ChatGPT, from ``chatGPTReachesKeypad``.
    private var sessionChatGPTRunning = false
    /// The last update of the session's ChatGPT state, so that updates arrive in order.
    private var chatGPTUpdate: Task<Void, Never>?
    /// Checks for the Accessibility permission while the user turns it on in System Settings.
    private var accessibilityCheck: Task<Void, Never>?

    init() {
        let environment = ProcessInfo.processInfo.environment
        emulationForced = ["1", "true", "yes"].contains(environment["PASEO_MICRO_EMULATED"]?.lowercased() ?? "")
        observeWorkspace()
        launchAtLogin.enableOnFirstInstalledRun()
        Task { await start() }
    }

    /// The symbol in the menu bar, which reflects the connection.
    var menuBarSymbol: String {
        if !keypad.connected { return "keyboard.badge.ellipsis" }
        if keypad.lightsPaused || !keypad.lightsVisible { return "keyboard.badge.exclamationmark" }
        return "keyboard"
    }

    /// The MCP port: the `PASEO_MICRO_MCP_PORT` environment variable,
    /// else the `mcpPort` default, else 7655.
    var mcpPort: Int {
        if let text = ProcessInfo.processInfo.environment["PASEO_MICRO_MCP_PORT"], let port = Int(text) { return port }
        let stored = UserDefaults.standard.integer(forKey: Self.portKey)
        return stored > 0 ? stored : MCPHTTPServer.defaultPort
    }

    /// The bridge's socket path: `PASEO_MICRO_BRIDGE_SOCKET`, else the default.
    var socketPath: String {
        ProcessInfo.processInfo.environment["PASEO_MICRO_BRIDGE_SOCKET"] ?? BridgeServer.defaultPath
    }

    // MARK: - Lifecycle

    private func start() async {
        let transport: any KeypadTransport
        if usesEmulator {
            let keypad = EmulatedKeypad()
            emulator = keypad
            transport = keypad
        } else {
            emulator = nil
            transport = HIDTransport()
        }
        // Find a running ChatGPT app before the session and the servers start,
        // so that no lighting write goes out on the ChatGPT layer while Codex already owns its lights.
        chatGPT = ChatGPTProcesses.running()
        chatGPTRunning = chatGPT.isRunning
        accessibilityTrusted = AXIsProcessTrusted()
        let session = KeypadSession(transport: transport)
        self.session = session
        sessionChatGPTRunning = chatGPTReachesKeypad
        await session.setChatGPTRunning(sessionChatGPTRunning)
        let updates = await session.updates()
        tasks.append(
            Task { [weak self] in
                var updates = updates
                while !Task.isCancelled {
                    do {
                        for try await event in updates {
                            guard let self else { return }
                            switch event {
                            case .state(let state): self.keypad = state
                            case .input(let input): self.lastInput = input
                            case .lights(let lights): self.lights = lights
                            }
                        }
                        return
                    } catch {
                        // The menu missed changes: subscribe again and read the state afresh.
                        updates = await session.updates()
                        guard let self else { return }
                        self.keypad = await session.state
                        self.lights = await session.lights
                        self.lastInput = await session.lastInput
                    }
                }
            }
        )
        await session.start()
        keypad = await session.state
        lights = await session.lights
        await startBridge(session)
        await startMCP(session)
    }

    private func startBridge(_ session: KeypadSession) async {
        let radial = RadialMenuController()
        tasks.append(
            Task { [weak self] in
                for await presentation in radial.presentations {
                    self?.radialMenu.show(presentation)
                    self?.escapeTap.menuChanged(open: presentation != nil)
                }
                self?.radialMenu.show(nil)
                self?.escapeTap.menuChanged(open: false)
            }
        )
        do {
            let bridge = try await BridgeServer.bind(
                path: socketPath,
                session: session,
                radialMenu: radial,
                selection: selection
            ) {
                [weak self] clients in
                Task { @MainActor in self?.bridgeClients = clients }
            }
            self.bridge = bridge
            bridgePath = bridge.path
            bridgeError = nil
            servers.append(Task { try? await bridge.run() })
        } catch {
            bridgePath = nil
            bridgeError = String(describing: error)
        }
    }

    private func startMCP(_ session: KeypadSession) async {
        do {
            let tools = KeypadTools(session: session)
            let mcp = try await MCPHTTPServer.bind(port: mcpPort, tools: tools)
            self.mcp = mcp
            mcpURL = mcp.url
            mcpError = nil
            servers.append(Task { try? await mcp.run() })
        } catch {
            mcpURL = nil
            mcpError = "Port \(mcpPort) is not available: \(error)"
        }
    }

    /// Stops the servers and the session.
    ///
    /// Closing a server closes its clients and removes its own socket file;
    /// waiting for the servers to finish lets a restart bind the same path and port.
    func shutdown() async {
        bridge?.close()
        bridge?.radialMenu.finish()
        mcp?.close()
        for server in servers { await server.value }
        servers.removeAll()
        for task in tasks { task.cancel() }
        tasks.removeAll()
        bridge = nil
        mcp = nil
        await session?.stop()
        session = nil
        bridgeClients = []
        keypad = .disconnected
    }

    private func restart() async {
        guard !restarting else { return }
        restarting = true
        defer { restarting = false }
        await shutdown()
        lastInput = nil
        await start()
    }

    /// Quits the app after it releases the keypad and the socket.
    func quit() {
        Task {
            await shutdown()
            NSApp.terminate(nil)
        }
    }

    // MARK: - Environment

    private func observeWorkspace() {
        let center = NSWorkspace.shared.notificationCenter
        observers.append(
            center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) {
                [weak self] notification in
                guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                else { return }
                let (processID, bundleID, path) = (app.processIdentifier, app.bundleIdentifier, app.bundleURL?.path)
                MainActor.assumeIsolated {
                    self?.chatGPT.launched(processID: processID, bundleIdentifier: bundleID, bundlePath: path)
                    self?.updateChatGPT()
                }
            }
        )
        observers.append(
            center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) {
                [weak self] notification in
                guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                else { return }
                let processID = app.processIdentifier
                MainActor.assumeIsolated {
                    self?.chatGPT.terminated(processID: processID)
                    self?.updateChatGPT()
                }
            }
        )
        observers.append(
            NotificationCenter.default.addObserver(
                forName: NSApplication.willTerminateNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    // Remove the socket even when the app quits without `quit()`.
                    self?.bridge?.close()
                }
            }
        )
    }

    /// Checks again for the ChatGPT app, the Accessibility permission, and the login item.
    func refreshEnvironment() {
        chatGPT = ChatGPTProcesses.running()
        accessibilityTrusted = AXIsProcessTrusted()
        launchAtLogin.refresh()
        updateChatGPT()
    }

    /// Whether the ChatGPT app runs and can reach the keypad:
    /// the keypad is real, since Codex does not reach the emulated one.
    private var chatGPTReachesKeypad: Bool {
        chatGPT.isRunning && emulator == nil
    }

    /// Mirrors the ChatGPT state and tells the session, in order,
    /// which pauses or resumes its lighting writes on the ChatGPT layer.
    private func updateChatGPT() {
        chatGPTRunning = chatGPT.isRunning
        let running = chatGPTReachesKeypad
        guard running != sessionChatGPTRunning else { return }
        sessionChatGPTRunning = running
        let previous = chatGPTUpdate
        let session = session
        chatGPTUpdate = Task {
            await previous?.value
            await session?.setChatGPTRunning(running)
        }
    }

    /// Asks for the Input Monitoring permission and opens its settings pane.
    func requestInputMonitoring() {
        EscapeKeyTap.requestInputMonitoring()
    }

    /// Asks for the Accessibility permission and opens its settings pane,
    /// then checks every second for two minutes, so that the menu updates once it is on.
    func requestAccessibility() {
        SystemInterfaceDriver.requestAccessibility()
        SystemInterfaceDriver.openAccessibilitySettings()
        accessibilityCheck?.cancel()
        accessibilityCheck = Task { [weak self] in
            for _ in 0 ..< 120 {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { return }
                self.accessibilityTrusted = AXIsProcessTrusted()
                if self.accessibilityTrusted { return }
            }
        }
    }
}
