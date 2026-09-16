// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "SurfaceLoomMacOSFixture",
    platforms: [.macOS(.v13)],
    products: [
        .executable(
            name: "SurfaceLoomMacOSFixture",
            targets: ["SurfaceLoomMacOSFixtureApp"]
        ),
        .executable(
            name: "SurfaceLoomMacOSFixtureModelTests",
            targets: ["SurfaceLoomMacOSFixtureModelTests"]
        ),
        .library(
            name: "SurfaceLoomMacOSFixtureModel",
            targets: ["SurfaceLoomMacOSFixtureModel"]
        ),
    ],
    targets: [
        .target(name: "SurfaceLoomMacOSFixtureModel"),
        .executableTarget(
            name: "SurfaceLoomMacOSFixtureApp",
            dependencies: ["SurfaceLoomMacOSFixtureModel"]
        ),
        .executableTarget(
            name: "SurfaceLoomMacOSFixtureModelTests",
            dependencies: ["SurfaceLoomMacOSFixtureModel"]
        ),
    ]
)
