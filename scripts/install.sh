#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Curzon VoiceAI — one-line macOS installer
#
#  Usage (paste into Terminal):
#    curl -fsSL https://raw.githubusercontent.com/kzr23/VoiceAI/main/scripts/install.sh | bash
#
#  Why this works without any Gatekeeper warning:
#  macOS only blocks apps that carry the `com.apple.quarantine` flag, which is
#  stamped on files downloaded by a *browser*. Files fetched with `curl` are NOT
#  quarantined, so the app installed by this script opens normally — no
#  right-click, no "Open Anyway", no manual `xattr`.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="kzr23/VoiceAI"
APP_NAME="Curzon"
TMP_DMG="$(mktemp -t curzon).dmg"
MOUNT="/tmp/curzon_install_vol"

cleanup() {
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -f "$TMP_DMG" 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "    Installing $APP_NAME VoiceAI"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Find the latest universal DMG asset ───────────────────────────────────
echo "  → Finding the latest release..."
API="https://api.github.com/repos/${REPO}/releases/latest"
DMG_URL="$(curl -fsSL "$API" \
  | grep -o '"browser_download_url"[^,]*universal\.dmg"' \
  | head -1 \
  | sed 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"//; s/"$//')"

if [ -z "$DMG_URL" ]; then
  echo "  ERROR: Could not find a universal .dmg in the latest release."
  echo "  Please download manually from: https://github.com/${REPO}/releases/latest"
  exit 1
fi
echo "    Found: $(basename "$DMG_URL")"

# ── 2. Download via curl (no quarantine flag is applied) ─────────────────────
echo "  → Downloading (~30-50 MB app shell)..."
curl -fSL --progress-bar "$DMG_URL" -o "$TMP_DMG"

# ── 3. Mount, copy to /Applications, strip any flag as a belt-and-suspenders ─
echo "  → Mounting disk image..."
hdiutil attach "$TMP_DMG" -mountpoint "$MOUNT" -nobrowse -quiet

APP_SRC="$MOUNT/${APP_NAME}.app"
if [ ! -d "$APP_SRC" ]; then
  echo "  ERROR: ${APP_NAME}.app not found inside the disk image."
  exit 1
fi

echo "  → Installing to /Applications..."
rm -rf "/Applications/${APP_NAME}.app"
cp -R "$APP_SRC" "/Applications/${APP_NAME}.app"
xattr -cr "/Applications/${APP_NAME}.app" 2>/dev/null || true

echo "  → Cleaning up..."
hdiutil detach "$MOUNT" -quiet 2>/dev/null || true

# ── 4. Launch ────────────────────────────────────────────────────────────────
echo ""
echo "  ✓ Done! Launching ${APP_NAME}..."
echo "    On first launch it installs the AI models (~1-2 GB, 10-20 min, once)."
echo ""
open "/Applications/${APP_NAME}.app"
