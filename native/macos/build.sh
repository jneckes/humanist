#!/bin/sh
# Builds native/macos/build/blueline-helper (SPEC 9.6 native/, 6.1): Blueline's macOS helper as one universal
# binary (arm64 + x86_64) for macOS 12 and later, with swiftc -O. Run it on a Mac with the Xcode command line
# tools before `npm run dist`: electron-builder ships the binary only when it exists (electron-builder.config.cjs,
# mac.extraResources), and a development run finds it here (packages/app/src/main/native-helper.ts).
#
# The binary is ad-hoc signed so a development run can start it on Apple silicon; electron-builder signs it again
# with the app's Developer ID and hardened runtime, and it is notarized with the app (README.md).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
src="$here/Sources/blueline-helper/main.swift"
out="$here/build"
mkdir -p "$out"

for arch in arm64 x86_64; do
  xcrun swiftc -O -whole-module-optimization \
    -target "$arch-apple-macos12.0" \
    -framework AppKit -framework CoreServices -framework UniformTypeIdentifiers \
    -o "$out/blueline-helper-$arch" "$src"
done

lipo -create -output "$out/blueline-helper" "$out/blueline-helper-arm64" "$out/blueline-helper-x86_64"
rm -f "$out/blueline-helper-arm64" "$out/blueline-helper-x86_64"
codesign --force --sign - "$out/blueline-helper"
lipo -info "$out/blueline-helper"
