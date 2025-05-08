#!/bin/bash

# PlexThing Mac Build + DMG Script
# Location: Save this inside your /Users/josh/Documents/PlexThing folder

set -e  # Stop immediately if any command fails

echo "📦 Cleaning old builds..."
rm -rf PlexThing-darwin-x64 PlexThing-temp.dmg PlexThing.dmg

echo "⚙️  Packing Mac app..."
npm run pack:mac

echo "💽 Creating temporary writable DMG..."
hdiutil create -volname "PlexThing" -srcfolder PlexThing-darwin-x64/PlexThing.app -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW PlexThing-temp.dmg

echo "🔌 Mounting DMG..."
hdiutil attach PlexThing-temp.dmg

echo "⏳ Waiting for DMG to fully mount..."
sleep 2

echo "🎨 Copying volume icon..."
cp /Users/josh/Documents/PlexThing/assets/MyIcon.icns /Volumes/PlexThing/.VolumeIcon.icns

echo "✨ Setting volume to show custom icon..."
SetFile -a C /Volumes/PlexThing

echo "🔗 Adding Applications shortcut..."
ln -s /Applications /Volumes/PlexThing/Applications

echo "⏏️  Detaching DMG..."
hdiutil detach /Volumes/PlexThing

echo "📦 Compressing final DMG..."
hdiutil convert PlexThing-temp.dmg -format UDZO -imagekey zlib-level=9 -o PlexThing.dmg

echo "🧹 Cleaning up temporary DMG..."
rm PlexThing-temp.dmg

echo "✅ Done! PlexThing.dmg is ready!"
