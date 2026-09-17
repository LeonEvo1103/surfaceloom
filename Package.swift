// swift-tools-version: 5.10

import PackageDescription

let package = Package(
	name: "SurfaceLoom",
	platforms: [.macOS(.v14)],
	products: [
		.library(name: "SurfaceLoomMacOS", targets: ["SurfaceLoomMacOS"]),
		.executable(name: "surfaceloom-macos-host", targets: ["SurfaceLoomMacOSHostExecutable"]),
	],
	targets: [
		.target(
			name: "SurfaceLoomNativeProtocol",
			path: "Sources/SurfaceLoomNativeProtocol"
		),
		.target(
			name: "SurfaceLoomMacOSHost",
			dependencies: ["SurfaceLoomNativeProtocol"],
			path: "Sources/SurfaceLoomMacOSHost"
		),
		.executableTarget(
			name: "SurfaceLoomMacOSHostExecutable",
			dependencies: ["SurfaceLoomMacOSHost"],
			path: "Sources/SurfaceLoomMacOSHostExecutable"
		),
		.target(
			name: "SurfaceLoomMacOS",
			path: "Sources/SurfaceLoomMacOS"
		),
		.testTarget(
			name: "SurfaceLoomMacOSTests",
			dependencies: ["SurfaceLoomMacOS"],
			path: "Tests/SurfaceLoomMacOSTests"
		),
		.testTarget(
			name: "SurfaceLoomNativeProtocolTests",
			dependencies: ["SurfaceLoomNativeProtocol"],
			path: "Tests/SurfaceLoomNativeProtocolTests"
		),
		.testTarget(
			name: "SurfaceLoomMacOSHostTests",
			dependencies: ["SurfaceLoomMacOSHost", "SurfaceLoomNativeProtocol"],
			path: "Tests/SurfaceLoomMacOSHostTests"
		),
	]
)
