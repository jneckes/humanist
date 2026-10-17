// swift-tools-version:5.9
// The macOS native helper (SPEC 6.1 Becoming the default app, 9.6 native/, 9.9 Write protocol addition).
// `swift build -c release` works for local checks; release builds use build.sh (universal arm64 + x86_64).
import PackageDescription

let package = Package(
    name: "blueline-helper",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "blueline-helper",
            path: "Sources/blueline-helper",
            linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("CoreServices"), .linkedFramework("UniformTypeIdentifiers")]
        ),
    ]
)
