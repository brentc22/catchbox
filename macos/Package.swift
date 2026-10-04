// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Catchbox",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "CatchboxCore"),
        .executableTarget(name: "Catchbox", dependencies: ["CatchboxCore"]),
        .executableTarget(name: "CatchboxTests", dependencies: ["CatchboxCore"]),
    ]
)
