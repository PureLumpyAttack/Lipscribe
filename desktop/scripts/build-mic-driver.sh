#!/usr/bin/env bash
# Build the "Lipscribe Microphone" virtual audio device for macOS.
#
# It is BlackHole (https://github.com/ExistentialAudio/BlackHole, GPL-3.0)
# compiled under our own name with its documented build-time settings: one
# device that is both a speaker (Lipscribe plays the voice into it) and a
# microphone (Zoom, Meet, Discord listen to it). It never becomes the system
# default input or output. The source is unmodified; the license and a link
# to the source ship inside the bundle.
#
# Output: .cache/drivers/LipscribeMicrophone.driver (universal arm64 + x86_64,
# ad-hoc signed). The app installs it into /Library/Audio/Plug-Ins/HAL.
# Needs only the Xcode command line tools (clang), no Xcode.
#
# Run from desktop/:  bash scripts/build-mic-driver.sh
set -euo pipefail
cd "$(dirname "$0")/.."

BLACKHOLE_TAG=v0.7.1
BLACKHOLE_SHA=7e9c4e9375d47abfe4b40515c5c35f0b7559936b # commit of that tag
NAME="Lipscribe Microphone"
BUNDLE_ID="com.purelumpyattack.lipscribe.microphone"
EXEC=LipscribeMicrophone
VERSION=1.0.0

SRC=.cache/BlackHole-$BLACKHOLE_SHA
OUT=.cache/drivers/$EXEC.driver

if [[ ! -f $SRC/BlackHole/BlackHole.c ]]; then
  mkdir -p .cache
  curl -fsSL "https://github.com/ExistentialAudio/BlackHole/archive/$BLACKHOLE_SHA.tar.gz" | tar -xz -C .cache
fi

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"

clang -bundle -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 \
  -DkDriver_Name="\"$NAME\"" \
  -DkDevice_Name="\"$NAME\"" \
  -DkDevice2_Name="\"$NAME Mirror\"" \
  -DkHas_Driver_Name_Format=false \
  -DkPlugIn_BundleID="\"$BUNDLE_ID\"" \
  -DkPlugIn_Icon="\"Lipscribe.icns\"" \
  -DkManufacturer_Name="\"Lipscribe\"" \
  -DkCanBeDefaultDevice=false \
  -DkCanBeDefaultSystemDevice=false \
  -framework CoreAudio -framework CoreFoundation -framework Accelerate \
  -o "$OUT/Contents/MacOS/$EXEC" "$SRC/BlackHole/BlackHole.c"

# Icon: the Lipscribe app icon (build/icon.png), shown in Audio MIDI Setup.
ICONSET=.cache/Lipscribe.iconset
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/Lipscribe.icns"
cp "$SRC/LICENSE" "$OUT/Contents/Resources/LICENSE-BlackHole.txt"
printf 'Built from BlackHole %s (%s)\nhttps://github.com/ExistentialAudio/BlackHole/tree/%s\nby scripts/build-mic-driver.sh in https://github.com/PureLumpyAttack/Lipscribe\n' \
  "$BLACKHOLE_TAG" "$BLACKHOLE_SHA" "$BLACKHOLE_SHA" > "$OUT/Contents/Resources/SOURCE.txt"

# Same plugin factory/type UUIDs as BlackHole's Info.plist; the factory
# function name (BlackHole_Create) is what the compiled code exports.
cat > "$OUT/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>English</string>
	<key>CFBundleExecutable</key>
	<string>$EXEC</string>
	<key>CFBundleIconFile</key>
	<string>Lipscribe.icns</string>
	<key>CFBundleIdentifier</key>
	<string>$BUNDLE_ID</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$NAME</string>
	<key>CFBundlePackageType</key>
	<string>BNDL</string>
	<key>CFBundleShortVersionString</key>
	<string>$VERSION</string>
	<key>CFBundleVersion</key>
	<string>$VERSION</string>
	<key>CFBundleSignature</key>
	<string>????</string>
	<key>CFPlugInFactories</key>
	<dict>
		<key>e395c745-4eea-4d94-bb92-46224221047c</key>
		<string>BlackHole_Create</string>
	</dict>
	<key>CFPlugInTypes</key>
	<dict>
		<key>443ABAB8-E7B3-491A-B985-BEB9187030DB</key>
		<array>
			<string>e395c745-4eea-4d94-bb92-46224221047c</string>
		</array>
	</dict>
</dict>
</plist>
EOF

codesign --force --sign - "$OUT"
echo "built $OUT ($(lipo -archs "$OUT/Contents/MacOS/$EXEC"))"
