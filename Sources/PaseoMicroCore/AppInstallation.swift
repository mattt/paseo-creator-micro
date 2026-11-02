import Foundation

/// Where the app runs from, and the repository that built it.
///
/// `Scripts/app.sh install` copies the app to `/Applications/Paseo Micro.app`.
/// The app turns on its login item the first time it runs from an Applications folder,
/// but not from a build folder.
public enum AppInstallation {
    /// The Info.plist key for the path of the repository that built the app,
    /// which `Scripts/app.sh` sets.
    public static let repositoryKey = "PaseoMicroRepository"

    /// The README's path in the repository.
    public static let readmePath = "README.md"

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

    /// Returns the repository that built the app.
    ///
    /// - Parameter infoDictionary: The app's Info.plist, such as `Bundle.main.infoDictionary`.
    /// - Returns: The folder in ``repositoryKey``, or `nil` if the key is missing or not an absolute path.
    public static func repository(infoDictionary: [String: Any]?) -> URL? {
        guard let path = infoDictionary?[repositoryKey] as? String, path.hasPrefix("/") else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    /// Returns the README in a repository, if the file exists.
    ///
    /// - Parameters:
    ///   - repository: The repository's folder, or `nil` if it is unknown.
    ///   - fileExists: Whether a file exists at a path.
    /// - Returns: The README at ``readmePath``, or `nil` if there is none.
    public static func readme(
        in repository: URL?,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> URL? {
        guard let repository else { return nil }
        let readme = repository.appendingPathComponent(readmePath)
        return fileExists(readme.path) ? readme : nil
    }
}
