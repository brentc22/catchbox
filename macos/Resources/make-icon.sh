#!/bin/zsh
# Renders Resources/icon.svg into everything that needs the logo: the app's .icns, the
# README image and the inbox favicon. One source, so the three can never drift apart.
# Needs macOS 14 or newer, where NSImage reads SVG.
set -e
cd "$(dirname "$0")"
ROOT=../..
TMP=$(mktemp -d)
DIR="$TMP/Catchbox.iconset"
mkdir -p "$DIR"

cat > "$TMP/render.swift" <<'SWIFT'
import AppKit

let args = CommandLine.arguments
guard let svg = NSImage(contentsOf: URL(fileURLWithPath: args[1])) else {
    fatalError("could not read \(args[1]) — NSImage reads SVG from macOS 14")
}
for size in args[3...].compactMap({ Int($0) }) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    svg.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!
        .write(to: URL(fileURLWithPath: "\(args[2])/src_\(size).png"))
}
SWIFT

swift "$TMP/render.swift" icon.svg "$DIR" 16 32 64 128 256 512 1024

# iconutil only accepts the ten standard names; the src_ files feed them.
for pair in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" "512 icon_256x256@2x" \
            "512 icon_512x512" "1024 icon_512x512@2x"; do
  parts=(${=pair})
  cp "$DIR/src_${parts[1]}.png" "$DIR/${parts[2]}.png"
done
cp "$DIR/src_256.png" icon.png
rm "$DIR"/src_*.png

iconutil -c icns "$DIR" -o Catchbox.icns
cp icon.svg "$ROOT/src/ui/icon.svg"
rm -rf "$TMP"
echo "wrote Catchbox.icns, icon.png and src/ui/icon.svg"
