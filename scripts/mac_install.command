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

# Use /Applications if writable (admin), else the user's own ~/Applications so
# standard (non-admin) accounts can install without sudo.
if [ -w /Applications ] 2>/dev/null; then
  APP_DIR="/Applications"
else
  APP_DIR="$HOME/Applications"
  mkdir -p "$APP_DIR"
fi
APP_DEST="$APP_DIR/Curzon.app"

if [ ! -d "$APP_SRC" ]; then
  echo "  ERROR: Curzon.app not found in this disk image."
  echo "  Please re-download from Gumroad and try again."
  read -rp "  Press Enter to close..." _
  exit 1
fi

echo "  Copying to $APP_DIR ..."
rm -rf "$APP_DEST" 2>/dev/null || true
cp -r "$APP_SRC" "$APP_DEST"

echo "  Removing macOS security quarantine flag..."
xattr -cr "$APP_DEST" 2>/dev/null || true

echo "  Verifying app signature..."
codesign --force --deep --sign - "$APP_DEST" 2>/dev/null || true

echo ""
echo "  Done! Launching Curzon now..."
echo "  (You can close this window)"
echo ""

open "$APP_DEST"
