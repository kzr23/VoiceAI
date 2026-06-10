#!/bin/bash
# ── Curzon VoiceAI — macOS Installer ─────────────────────────────────────────
# Double-click this file to install Curzon to /Applications automatically.
# Handles the macOS quarantine flag so no manual xattr command is needed.

DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "    Installing Curzon VoiceAI"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

APP_SRC="$DIR/Curzon.app"
APP_DEST="/Applications/Curzon.app"

if [ ! -d "$APP_SRC" ]; then
  echo "  ERROR: Curzon.app not found in this disk image."
  echo "  Please re-download from Gumroad and try again."
  read -rp "  Press Enter to close..." _
  exit 1
fi

echo "  Copying to /Applications..."
rm -rf "$APP_DEST"
cp -r "$APP_SRC" "$APP_DEST"

echo "  Removing macOS security quarantine flag..."
xattr -cr "$APP_DEST"

echo ""
echo "  Done! Launching Curzon now..."
echo "  (You can close this window)"
echo ""

open "$APP_DEST"
