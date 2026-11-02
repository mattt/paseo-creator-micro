import AppKit
import PaseoMicroCore

/// The app's About panel, and the files and apps that its menu opens.
@MainActor
enum AppInfo {
    /// The one-line description in the About panel.
    static let summary = "Connects a Work Louder Creator Micro 2 to Paseo: lights, keys, the dial, and the joystick."

    /// The repository that built the app, from its Info.plist.
    static var repository: URL? {
        AppInstallation.repository(infoDictionary: Bundle.main.infoDictionary)
    }

    /// The README in the repository, if it exists.
    static var readme: URL? {
        AppInstallation.readme(in: repository)
    }

    /// Paseo's desktop app, if it is installed.
    static var paseo: URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: RadialMenu.defaultBundleID)
    }

    /// Shows the standard About panel, with the app's name, version, and build from its Info.plist,
    /// and the description and repository path below them.
    static func showAbout() {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        let credits = NSMutableAttributedString(
            string: summary,
            attributes: [.font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph]
        )
        if let repository {
            credits.append(
                NSAttributedString(
                    string: "\n\n" + (repository.path as NSString).abbreviatingWithTildeInPath,
                    attributes: [
                        .font: font, .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: paragraph,
                    ]
                )
            )
        }
        // A menu bar app is not active, so the panel would open behind other apps.
        NSApp.activate()
        NSApp.orderFrontStandardAboutPanel(options: [.credits: credits])
    }

    /// Brings Paseo to the front, opening it if it does not run.
    ///
    /// Paseo's links open agents only, so there is no link to its plugin settings.
    static func openPaseo() {
        guard let paseo else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: paseo, configuration: configuration, completionHandler: nil)
    }

    /// Opens the README in the app that opens Markdown files.
    static func openReadme() {
        guard let readme else { return }
        NSWorkspace.shared.open(readme)
    }
}
