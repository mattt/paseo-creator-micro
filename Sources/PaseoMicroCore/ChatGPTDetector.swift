import AppKit

/// Detects the ChatGPT app, whose Codex integration also drives the keypad.
///
/// Codex resets the keypad's lights within about two minutes while the ChatGPT app runs,
/// so the app pauses its own lighting writes on the ChatGPT layer
/// and repaints its lights on other layers (see ``KeypadSession/setChatGPTRunning(_:)``)
/// until the ChatGPT app quits.
public enum ChatGPTDetector {
    /// The ChatGPT app's bundle identifier.
    public static let bundleIdentifier = "com.openai.chat"

    /// The ChatGPT app's usual location.
    public static let bundlePath = "/Applications/ChatGPT.app"

    /// Returns whether an app is the ChatGPT app.
    ///
    /// - Parameters:
    ///   - bundleIdentifier: The app's bundle identifier, if any.
    ///   - bundlePath: The path of the app's bundle, if any.
    /// - Returns: `true` if the identifier is `com.openai.chat` or the bundle is `/Applications/ChatGPT.app`.
    public static func isChatGPT(bundleIdentifier: String?, bundlePath: String?) -> Bool {
        if bundleIdentifier == Self.bundleIdentifier { return true }
        guard let bundlePath else { return false }
        return URL(fileURLWithPath: bundlePath).standardizedFileURL.path == Self.bundlePath
    }

    /// Returns whether the ChatGPT app is running.
    ///
    /// - Returns: `true` if any running app is the ChatGPT app.
    public static func isRunning() -> Bool {
        NSWorkspace.shared.runningApplications.contains {
            isChatGPT(bundleIdentifier: $0.bundleIdentifier, bundlePath: $0.bundleURL?.path)
        }
    }
}

/// The ChatGPT processes that run, kept current from launch and termination notifications.
///
/// The app fills it from `NSWorkspace`'s running applications,
/// then updates it from `didLaunchApplicationNotification`
/// and `didTerminateApplicationNotification`,
/// so that it does not depend on when the running-applications list catches up.
public struct ChatGPTProcesses: Sendable, Hashable {
    /// The process identifiers of the running ChatGPT apps.
    public private(set) var processIDs: Set<Int32> = []

    /// Creates an empty set: no ChatGPT app runs.
    public init() {}

    /// Whether any ChatGPT app runs.
    public var isRunning: Bool { !processIDs.isEmpty }

    /// Records that an app launched; apps other than ChatGPT are ignored.
    ///
    /// - Parameters:
    ///   - processID: The app's process identifier.
    ///   - bundleIdentifier: The app's bundle identifier, if any.
    ///   - bundlePath: The path of the app's bundle, if any.
    public mutating func launched(processID: Int32, bundleIdentifier: String?, bundlePath: String?) {
        guard ChatGPTDetector.isChatGPT(bundleIdentifier: bundleIdentifier, bundlePath: bundlePath) else { return }
        processIDs.insert(processID)
    }

    /// Records that an app terminated.
    ///
    /// - Parameter processID: The app's process identifier.
    public mutating func terminated(processID: Int32) {
        processIDs.remove(processID)
    }

    /// Returns the ChatGPT apps that run now.
    ///
    /// - Returns: The processes, from `NSWorkspace`'s running applications.
    public static func running() -> ChatGPTProcesses {
        var processes = ChatGPTProcesses()
        for app in NSWorkspace.shared.runningApplications {
            processes.launched(
                processID: app.processIdentifier,
                bundleIdentifier: app.bundleIdentifier,
                bundlePath: app.bundleURL?.path
            )
        }
        return processes
    }
}
