#!/bin/zsh
# Generates Resources/Catchbox.icns without any external design tools: an open tray
# catching an arrow, white on the inbox's indigo accent.
set -e
cd "$(dirname "$0")"
TMP=$(mktemp -d)
DIR="$TMP/Catchbox.iconset"
mkdir -p "$DIR"

cat > "$TMP/icon.swift" <<'SWIFT'
import AppKit

for size in [16, 32, 64, 128, 256, 512, 1024] {
    let s = CGFloat(size)
    let image = NSImage(size: NSSize(width: s, height: s))
    image.lockFocus()

    // macOS icon grid: the tile sits inside a 10% margin.
    let inset = s * 0.1
    let tile = NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let shape = NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.225, yRadius: tile.width * 0.225)
    NSGradient(starting: NSColor(srgbRed: 0.42, green: 0.44, blue: 0.97, alpha: 1),
               ending: NSColor(srgbRed: 0.29, green: 0.26, blue: 0.80, alpha: 1))!
        .draw(in: shape, angle: -90)

    let u = tile.width / 100 // design in a 100-unit square
    func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: tile.minX + x * u, y: tile.minY + y * u) }
    NSColor.white.setStroke()

    // The tray: sides, a floor, and the dip in the middle where mail lands.
    let tray = NSBezierPath()
    tray.lineWidth = 7 * u
    tray.lineCapStyle = .round
    tray.lineJoinStyle = .round
    tray.move(to: p(22, 50))
    tray.line(to: p(22, 26))
    tray.line(to: p(78, 26))
    tray.line(to: p(78, 50))
    tray.move(to: p(22, 44))
    tray.line(to: p(38, 44))
    tray.line(to: p(42, 36))
    tray.line(to: p(58, 36))
    tray.line(to: p(62, 44))
    tray.line(to: p(78, 44))
    tray.stroke()

    // The arrow coming down into it.
    let arrow = NSBezierPath()
    arrow.lineWidth = 7 * u
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: p(50, 80))
    arrow.line(to: p(50, 52))
    arrow.move(to: p(39, 63))
    arrow.line(to: p(50, 52))
    arrow.line(to: p(61, 63))
    arrow.stroke()

    image.unlockFocus()
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { continue }
    try? png.write(to: URL(fileURLWithPath: CommandLine.arguments[1] + "/src_\(size).png"))
}
SWIFT

swift "$TMP/icon.swift" "$DIR"

# iconutil only accepts the ten standard names; the src_ files feed them.
for pair in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" "512 icon_256x256@2x" \
            "512 icon_512x512" "1024 icon_512x512@2x"; do
  parts=(${=pair})
  cp "$DIR/src_${parts[1]}.png" "$DIR/${parts[2]}.png"
done
rm "$DIR"/src_*.png

iconutil -c icns "$DIR" -o Catchbox.icns
rm -rf "$TMP"
echo "wrote Resources/Catchbox.icns"
