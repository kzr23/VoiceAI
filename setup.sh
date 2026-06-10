#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Curzon VoiceAI — macOS Setup Script
#  Supports: macOS 12+ · Apple Silicon (M1/M2/M3) + Intel
#
#  What this script does:
#    1. Installs Homebrew (if missing)
#    2. Installs Python 3.11 and FFmpeg via Homebrew
#    3. Creates a Python virtual environment in backend/venv/
#    4. Installs all Python audio/TTS packages
#    5. Downloads Kokoro ONNX voice model  (~100 MB)
#    6. Downloads OpenVoice V2 model files (~1.8 GB)
#    7. Downloads NLTK language data
#
#  Run once before opening Curzon.app for the first time.
# ═══════════════════════════════════════════════════════════════════════════════

set -uo pipefail

# ── Terminal colors ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${CYAN}▶${NC}  $*"; }
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗  ERROR:${NC}  $*"; exit 1; }
step() { echo; echo -e "${BOLD}${BLUE}━━━  $*  ━━━${NC}"; echo; }
sep()  { echo -e "${BLUE}───────────────────────────────────────────────────────────${NC}"; }

# ── Resolve paths ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# App-managed setup: honour the path provided by the Tauri app
if [[ -n "${CURZON_BACKEND_DIR:-}" ]]; then
    BACKEND_DIR="$CURZON_BACKEND_DIR"
    mkdir -p "$BACKEND_DIR"
# Manual setup: detect from script location
elif [[ -f "$SCRIPT_DIR/generate.py" ]]; then
    BACKEND_DIR="$SCRIPT_DIR"
elif [[ -d "$SCRIPT_DIR/backend" ]]; then
    BACKEND_DIR="$SCRIPT_DIR/backend"
else
    err "Cannot find backend/ folder. Run this script from the Curzon project root."
fi

VENV_DIR="$BACKEND_DIR/venv"
PY=""

# ══════════════════════════════════════════════════════════════════════════════
if [[ -z "${CURZON_NON_INTERACTIVE:-}" ]]; then
clear
echo
echo -e "${BOLD}${BLUE}"
echo "   ██████╗██╗   ██╗██████╗ ███████╗ ██████╗ ███╗   ██╗"
echo "  ██╔════╝██║   ██║██╔══██╗╚══███╔╝██╔═══██╗████╗  ██║"
echo "  ██║     ██║   ██║██████╔╝  ███╔╝ ██║   ██║██╔██╗ ██║"
echo "  ██║     ██║   ██║██╔══██╗ ███╔╝  ██║   ██║██║╚██╗██║"
echo "  ╚██████╗╚██████╔╝██║  ██║███████╗╚██████╔╝██║ ╚████║"
echo "   ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝"
echo -e "${NC}"
echo -e "  ${BOLD}VoiceAI — macOS Setup${NC}"
sep
echo
echo "  This script will install all dependencies and voice models."
echo "  Estimated download: ~2–4 GB | Estimated time: 10–30 min"
echo
sep
echo

read -rp "  Continue? [Y/n] " yn
[[ "${yn,,}" == "n" ]] && echo "  Setup cancelled." && exit 0
else
log "Curzon first-time setup — backend: $BACKEND_DIR"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "1/7 · Homebrew"
# ═══════════════════════════════════════════════════════════════════════════════
if ! command -v brew &>/dev/null; then
    log "Homebrew not found — installing..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Activate for Apple Silicon
    if [[ -x /opt/homebrew/bin/brew ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
    fi
else
    ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "2/7 · Python 3.11"
# ═══════════════════════════════════════════════════════════════════════════════
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
    BREW_PREFIX="/opt/homebrew"
else
    BREW_PREFIX="/usr/local"
fi

PY311="$BREW_PREFIX/bin/python3.11"
if [[ ! -x "$PY311" ]]; then
    log "Installing Python 3.11 via Homebrew..."
    brew install python@3.11
fi

# Locate Python executable
for candidate in \
    "$BREW_PREFIX/bin/python3.11" \
    "$BREW_PREFIX/opt/python@3.11/bin/python3.11" \
    "/usr/bin/python3.11" \
    "python3.11"; do
    if command -v "$candidate" &>/dev/null 2>&1 || [[ -x "$candidate" ]]; then
        PY="$candidate"; break
    fi
done

[[ -z "$PY" ]] && err "python3.11 not found after installation. Try: brew install python@3.11"
ok "$(${PY} --version) at ${PY}"

# ═══════════════════════════════════════════════════════════════════════════════
step "3/7 · FFmpeg"
# ═══════════════════════════════════════════════════════════════════════════════
if ! command -v ffmpeg &>/dev/null && [[ ! -x "$BREW_PREFIX/bin/ffmpeg" ]]; then
    log "Installing FFmpeg..."
    brew install ffmpeg
else
    FFVER=$(ffmpeg -version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
    ok "FFmpeg $FFVER"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "4/7 · Python Virtual Environment & Packages"
# ═══════════════════════════════════════════════════════════════════════════════
if [[ ! -d "$VENV_DIR" ]]; then
    log "Creating virtual environment at $VENV_DIR ..."
    "$PY" -m venv "$VENV_DIR"
    ok "Virtual environment created"
else
    ok "Virtual environment already exists"
fi

# Copy bundled AI scripts from app resources (when called by Curzon app)
if [[ -n "${CURZON_RESOURCE_DIR:-}" ]] && [[ -d "${CURZON_RESOURCE_DIR}/backend" ]]; then
    log "Copying AI engine scripts..."
    cp -f "${CURZON_RESOURCE_DIR}/backend/"*.py  "$BACKEND_DIR/" 2>/dev/null || true
    cp -f "${CURZON_RESOURCE_DIR}/backend/voices.json" "$BACKEND_DIR/" 2>/dev/null || true
    ok "AI engine scripts ready"
fi

VPYTHON="$VENV_DIR/bin/python3"
VPIP="$VENV_DIR/bin/pip"

log "Upgrading pip, setuptools, wheel..."
"$VPIP" install --quiet --upgrade pip setuptools wheel

log "Installing core audio packages..."
"$VPIP" install --quiet \
    "numpy>=2.0.0" "scipy>=1.11.0" "librosa>=0.10.2" "soundfile>=0.12.1" \
    "pydub>=0.25.1" "noisereduce>=3.0.2" "pedalboard>=0.9.0" \
    "nltk>=3.8.1" "requests>=2.31.0" "tqdm>=4.66.0"
ok "Core audio packages installed"

log "Installing ONNX runtime..."
"$VPIP" install --quiet "onnxruntime>=1.18.0"
ok "ONNX runtime installed"

log "Installing Kokoro TTS..."
"$VPIP" install --quiet "kokoro-onnx>=0.4.0"
ok "Kokoro TTS installed"

log "Installing Piper TTS..."
"$VPIP" install --quiet "piper-tts>=1.2.0" || warn "Piper TTS install had warnings (non-fatal)"
ok "Piper TTS installed"

log "Installing PyTorch (CPU/MPS — ~600 MB)..."
if [[ "$ARCH" == "arm64" ]]; then
    # Apple Silicon: standard PyTorch includes MPS acceleration
    "$VPIP" install --quiet torch torchaudio
else
    # Intel Mac: CPU-only build (smaller download)
    "$VPIP" install --quiet torch torchaudio \
        --index-url https://download.pytorch.org/whl/cpu
fi
ok "PyTorch installed"

log "Installing Coqui TTS (~200 MB including models)..."
COQUI_TOS_AGREED=1 "$VPIP" install --quiet "TTS>=0.22.0"
ok "Coqui TTS installed"

log "Installing F5-TTS (zero-shot voice cloning)..."
"$VPIP" install --quiet "f5-tts>=0.3.0" "cached_path"
ok "F5-TTS installed"

log "Installing OpenVoice V2 (from GitHub)..."
"$VPIP" install --quiet \
    "git+https://github.com/myshell-ai/OpenVoice.git@main#egg=openvoice" \
    || warn "OpenVoice install had issues — some voice styles may be unavailable"
ok "OpenVoice installed"

# ═══════════════════════════════════════════════════════════════════════════════
step "5/7 · NLTK Language Data"
# ═══════════════════════════════════════════════════════════════════════════════
log "Downloading NLTK tokeniser data..."
"$VPYTHON" - <<'EOF'
import nltk, ssl
try:
    _ctx = ssl._create_unverified_context
except AttributeError:
    pass
else:
    ssl._create_default_https_context = _ctx
for pkg in ("punkt","punkt_tab","averaged_perceptron_tagger","averaged_perceptron_tagger_eng"):
    nltk.download(pkg, quiet=True)
print("NLTK data ready")
EOF
ok "NLTK data downloaded"

# ═══════════════════════════════════════════════════════════════════════════════
step "6/7 · Kokoro Voice Model  (~100 MB)"
# ═══════════════════════════════════════════════════════════════════════════════
KOKORO_DIR="$BACKEND_DIR/models/kokoro"
KOKORO_ONNX="$KOKORO_DIR/kokoro-v1.0.onnx"
mkdir -p "$KOKORO_DIR"

if [[ -f "$KOKORO_ONNX" ]] && [[ $(stat -f%z "$KOKORO_ONNX" 2>/dev/null || echo 0) -gt 10000000 ]]; then
    ok "Kokoro model already downloaded"
else
    log "Downloading Kokoro ONNX model files..."
    "$VPYTHON" "$BACKEND_DIR/download_kokoro.py" \
        && ok "Kokoro model downloaded" \
        || warn "Kokoro download failed — retry later with: python backend/download_kokoro.py"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "7/7 · OpenVoice V2 Models  (~1.8 GB)"
# ═══════════════════════════════════════════════════════════════════════════════
OV_DIR="$BACKEND_DIR/openvoice_model"
OV_CKPT="$OV_DIR/converter/checkpoint.pth"

if [[ -f "$OV_CKPT" ]] && [[ $(stat -f%z "$OV_CKPT" 2>/dev/null || echo 0) -gt 100000000 ]]; then
    ok "OpenVoice V2 models already downloaded"
else
    log "Downloading OpenVoice V2 models (~1.8 GB — please wait)..."
    "$VPYTHON" "$BACKEND_DIR/download_model.py" \
        && ok "OpenVoice V2 models downloaded" \
        || warn "OpenVoice download failed — the app will prompt you on first launch"
fi

# ══════════════════════════════════════════════════════════════════════════════
echo
sep
echo -e "  ${GREEN}${BOLD}✓  Setup complete!${NC}"
sep
echo
echo -e "  ${BOLD}What's next:${NC}"
echo "   1. Open  Curzon.app  (double-click the application)"
echo "   2. All voice engines are ready — no internet required"
echo
echo -e "  ${BOLD}If you encounter issues:${NC}"
echo "   • Re-run this script — it safely skips completed steps"
echo "   • Check that  backend/venv/  exists and contains packages"
echo
