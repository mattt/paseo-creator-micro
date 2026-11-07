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
}
