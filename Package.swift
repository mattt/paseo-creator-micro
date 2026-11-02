// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "paseo-creator-micro",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .library(name: "CreatorMicro", targets: ["CreatorMicro"]),
        .library(name: "PaseoMicroCore", targets: ["PaseoMicroCore"]),
        // The menu bar app's executable; `mise run build:app` puts it in PaseoMicro.app.
        .executable(name: "PaseoMicro", targets: ["PaseoMicro"]),
        .executable(name: "micro", targets: ["micro"]),
    ],
    dependencies: [
        .package(url: "https://github.com/modelcontextprotocol/swift-sdk.git", exact: "0.12.1"),
        // Already a dependency of the MCP SDK; the HTTP and bridge servers use it directly.
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.65.0"),
    ],
    targets: [
        .target(name: "CreatorMicro"),
        .target(
            name: "PaseoMicroCore",
            dependencies: [
                "CreatorMicro",
                .product(name: "MCP", package: "swift-sdk"),
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
            ]
        ),
        .executableTarget(name: "PaseoMicro", dependencies: ["CreatorMicro", "PaseoMicroCore"]),
        .executableTarget(name: "micro", dependencies: ["PaseoMicroCore"]),
        .testTarget(name: "CreatorMicroTests", dependencies: ["CreatorMicro"]),
        .testTarget(
            name: "PaseoMicroCoreTests",
            dependencies: [
                "CreatorMicro",
                "PaseoMicroCore",
                .product(name: "MCP", package: "swift-sdk"),
            ]
        ),
    ]
)
