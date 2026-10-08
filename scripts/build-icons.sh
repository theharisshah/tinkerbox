#!/bin/sh
# Builds the app icons from build/icon.svg: build/icon.png (all platforms) and build/icon.icns (macOS).
set -e
cd "$(dirname "$0")/.."
npx electron scripts/render-icon.cjs
if command -v iconutil >/dev/null 2>&1; then
  set_dir=build/icon.iconset
  rm -rf "$set_dir" && mkdir -p "$set_dir"
  for size in 16 32 128 256 512; do
    sips -z $size $size build/icon.png --out "$set_dir/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z $double $double build/icon.png --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$set_dir" -o build/icon.icns
  rm -rf "$set_dir"
fi
echo "Icons written to build/"
