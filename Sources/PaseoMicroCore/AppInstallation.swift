import Foundation

/// Where the app runs from.
///
/// `Scripts/app.sh install` copies the app to `/Applications/Paseo Micro.app`.
/// The app turns on its login item the first time it runs from an Applications folder,
/// but not from a build folder.
public enum AppInstallation {
    /// Returns whether a bundle is inside an Applications folder.
    ///
    /// - Parameters:
    ///   - bundleURL: The app bundle's location.
    ///   - homeDirectory: The user's home folder, whose `Applications` folder also counts.
    /// - Returns: `true` if the bundle is inside `/Applications` or `~/Applications`, at any depth.
    public static func isInstalled(bundleURL: URL, homeDirectory: URL) -> Bool {
        let bundle = bundleURL.standardizedFileURL.pathComponents
        let folders = [URL(fileURLWithPath: "/Applications"), homeDirectory.appendingPathComponent("Applications")]
        return folders.contains { folder in
            let root = folder.standardizedFileURL.pathComponents
            return bundle.count > root.count && Array(bundle.prefix(root.count)) == root
        }
    }
}
