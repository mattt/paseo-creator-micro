import Foundation
import Observation
import PaseoMicroCore
import ServiceManagement

/// The app's login item, which `SMAppService.mainApp` registers.
///
/// The login item is on by default the first time the app runs from an Applications folder.
/// A copy in a build folder never turns it on by itself,
/// so that a development build does not take the installed copy's place at login.
@MainActor
@Observable
final class LaunchAtLogin {
    /// The login item's status, as of the last ``refresh()``.
    private(set) var status: SMAppService.Status
    /// Why the last change failed, if it did.
    private(set) var error: String?
    /// Whether the app runs from an Applications folder.
    let isInstalled: Bool

    /// Set once the login item has been turned on for the first run, or turned on or off in the menu.
    private static let decidedKey = "launchAtLoginDecided"

    init(bundleURL: URL = Bundle.main.bundleURL) {
        isInstalled = AppInstallation.isInstalled(
            bundleURL: bundleURL,
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser
        )
        status = SMAppService.mainApp.status
    }

    /// Whether the login item is registered, even if macOS still needs the user's approval.
    var isEnabled: Bool {
        status == .enabled || status == .requiresApproval
    }

    /// Whether macOS needs the user's approval in Login Items settings.
    var needsApproval: Bool {
        status == .requiresApproval
    }

    /// Turns the login item on or off from the menu.
    func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(true, forKey: Self.decidedKey)
        change(to: enabled)
    }

    /// Turns the login item on the first time the app runs from an Applications folder.
    func enableOnFirstInstalledRun() {
        guard isInstalled, !UserDefaults.standard.bool(forKey: Self.decidedKey) else { return }
        UserDefaults.standard.set(true, forKey: Self.decidedKey)
        refresh()
        if !isEnabled { change(to: true) }
    }

    /// Reads the login item's status again, which the user can change in System Settings.
    func refresh() {
        status = SMAppService.mainApp.status
    }

    /// Opens Login Items in System Settings.
    func openSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    private func change(to enabled: Bool) {
        var failure: (any Error)?
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            failure = error
        }
        refresh()
        // A registration that waits for approval also throws; the status already says so.
        if let failure, isEnabled != enabled {
            error = failure.localizedDescription
        } else {
            error = nil
        }
    }
}
