// swift-tools-version: 5.10

import PackageDescription

let package = Package(
	name: "SurfaceLoom",
	platforms: [.macOS(.v14)],
	products: [
		.library(name: "SurfaceLoomMacOS", targets: ["SurfaceLoomMacOS"]),
	],
	targets: [
		.target(
			name: "SurfaceLoomMacOS",
			path: "Sources/SurfaceLoomMacOS"
		),
		.testTarget(
			name: "SurfaceLoomMacOSTests",
			dependencies: ["SurfaceLoomMacOS"],
			path: "Tests/SurfaceLoomMacOSTests"
		),
	]
)
