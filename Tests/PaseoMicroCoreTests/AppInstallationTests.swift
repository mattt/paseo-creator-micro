import Foundation
@testable import PaseoMicroCore
import Testing

@Suite("App installation")
struct AppInstallationTests {
    let home = URL(fileURLWithPath: "/Users/someone", isDirectory: true)

    @Test(
        "An app in an Applications folder is installed",
        arguments: [
            "/Applications/Paseo Micro.app",
            "/Applications/Utilities/Paseo Micro.app",
            "/Users/someone/Applications/Paseo Micro.app",
            "/Applications/../Applications/Paseo Micro.app",
        ]
    )
    func installed(path: String) {
        #expect(AppInstallation.isInstalled(bundleURL: URL(fileURLWithPath: path), homeDirectory: home))
    }

    @Test(
        "An app in a build folder or elsewhere is not installed",
        arguments: [
            "/Users/someone/Code/paseo-creator-micro/build/PaseoMicro.app",
            "/Applications",
            "/ApplicationsOld/Paseo Micro.app",
            "/Users/other/Applications/Paseo Micro.app",
            "/Volumes/Disk/Applications/Paseo Micro.app",
        ]
    )
    func notInstalled(path: String) {
        #expect(!AppInstallation.isInstalled(bundleURL: URL(fileURLWithPath: path), homeDirectory: home))
    }

    @Test("The repository comes from an absolute path in the Info.plist")
    func repository() {
        let info: [String: Any] = [AppInstallation.repositoryKey: "/Users/someone/Code/paseo-creator-micro"]
        #expect(AppInstallation.repository(infoDictionary: info)?.path == "/Users/someone/Code/paseo-creator-micro")
        #expect(AppInstallation.repository(infoDictionary: nil) == nil)
        #expect(AppInstallation.repository(infoDictionary: [:]) == nil)
        #expect(AppInstallation.repository(infoDictionary: [AppInstallation.repositoryKey: "relative/path"]) == nil)
        #expect(AppInstallation.repository(infoDictionary: [AppInstallation.repositoryKey: 7]) == nil)
    }

    @Test("The README is shown only when the repository has one")
    func readme() {
        let repository = URL(fileURLWithPath: "/Users/someone/Code/paseo-creator-micro", isDirectory: true)
        let expected = "/Users/someone/Code/paseo-creator-micro/README.md"
        #expect(AppInstallation.readme(in: repository) { $0 == expected }?.path == expected)
        #expect(AppInstallation.readme(in: repository) { _ in false } == nil)
        #expect(AppInstallation.readme(in: nil) { _ in true } == nil)
    }
}
