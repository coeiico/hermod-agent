#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# ImageMagick is needed only to regenerate assets, not to build the extension.
if command -v magick >/dev/null 2>&1; then
  image_tool=magick
elif command -v convert >/dev/null 2>&1; then
  image_tool=convert
else
  echo 'Install ImageMagick to regenerate the Hermod icons.' >&2
  exit 1
fi

mkdir -p public/icon
for size in 16 24 32 48 64 96 128 180 192 256 512 1024; do
  "$image_tool" assets/brand/icon.png -filter Lanczos -resize "${size}x${size}" -strip "public/icon/${size}.png"
done

"$image_tool" public/icon/16.png public/icon/32.png public/icon/48.png public/favicon.ico
