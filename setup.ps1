# ═══════════════════════════════════════════════════════════════════════════════
#  Curzon VoiceAI — Windows Setup Script (PowerShell)
#  Supports: Windows 10 (1903+) · Windows 11  · x86_64
#
#  What this script does:
#    1. Verifies / guides Python 3.11 installation
#    2. Checks / installs FFmpeg via winget
#    3. Creates a Python virtual environment in backend\venv\
#    4. Installs all Python audio/TTS packages
#    5. Downloads Kokoro ONNX voice model  (~100 MB)
#    6. Downloads OpenVoice V2 model files (~1.8 GB)
#    7. Downloads NLTK language data
#
#  Run once (as regular user) before opening Curzon for the first time.
#  Right-click → "Run with PowerShell"
# ═══════════════════════════════════════════════════════════════════════════════
#Requires -Version 5.1

$ErrorActionPreference = "Stop"

# ── Helpers ────────────────────────────────────────────────────────────────────
function Log  { Write-Host "  >> $args" -ForegroundColor Cyan }
function Ok   { Write-Host "  [OK] $args" -ForegroundColor Green }
function Warn { Write-Host "  [WARN] $args" -ForegroundColor Yellow }
function Err  { Write-Host "  [ERROR] $args" -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }
function Step { Write-Host; Write-Host "  ━━━  $args  ━━━" -ForegroundColor Blue; Write-Host }
function Sep  { Write-Host "  ─────────────────────────────────────────────────────" -ForegroundColor DarkBlue }

# ── Resolve paths ──────────────────────────────────────────────────────────────
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ResourceDir = $env:CURZON_RESOURCE_DIR
$BackendDir  = $env:CURZON_BACKEND_DIR

if (-not $BackendDir) {
    if (Test-Path (Join-Path $ScriptDir "generate.py")) {
        $BackendDir = $ScriptDir
    } elseif (Test-Path (Join-Path $ScriptDir "backend")) {
        $BackendDir = Join-Path $ScriptDir "backend"
    } else {
        Err "Cannot find backend\ folder. Run this script from the Curzon project root."
    }
}

if (-not (Test-Path $BackendDir)) { New-Item -ItemType Directory -Path $BackendDir -Force | Out-Null }

$VenvDir    = Join-Path $BackendDir "venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip    = Join-Path $VenvDir "Scripts\pip.exe"

# ══════════════════════════════════════════════════════════════════════════════
if (-not $env:CURZON_NON_INTERACTIVE) {
Clear-Host
Write-Host
Write-Host "   ██████╗██╗   ██╗██████╗ ███████╗ ██████╗ ███╗   ██╗" -ForegroundColor Blue
Write-Host "  ██╔════╝██║   ██║██╔══██╗╚══███╔╝██╔═══██╗████╗  ██║" -ForegroundColor Blue
Write-Host "  ██║     ██║   ██║██████╔╝  ███╔╝ ██║   ██║██╔██╗ ██║" -ForegroundColor Blue
Write-Host "  ╚██████╗╚██████╔╝██║  ██║███████╗╚██████╔╝██║ ╚████║" -ForegroundColor Blue
Write-Host "   ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝" -ForegroundColor Blue
Write-Host
Write-Host "  VoiceAI — Windows Setup" -ForegroundColor White
Sep
Write-Host
Write-Host "  This will install all dependencies and voice models."
Write-Host "  Estimated download: ~2-4 GB | Estimated time: 10-30 min"
Write-Host
Sep
Write-Host

$continue = Read-Host "  Continue? [Y/n]"
if ($continue -eq "n" -or $continue -eq "N") { Write-Host "  Setup cancelled."; exit 0 }
} else {
    Log "Curzon first-time setup — backend: $BackendDir"
}

# ═══════════════════════════════════════════════════════════════════════════════
Step "1/7 · Python 3.11"
# ═══════════════════════════════════════════════════════════════════════════════
$PythonExe = $null

# Check common installation locations
$PythonCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
    "C:\Python311\python.exe",
    "C:\Python312\python.exe",
    (Join-Path $env:USERPROFILE "AppData\Local\Programs\Python\Python311\python.exe")
)

# Also check via 'py' launcher (Python for Windows)
try {
    $pyVer = & py -3.11 --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        $PythonExe = "py -3.11"
        Ok "Python 3.11 found via py launcher: $pyVer"
    }
} catch {}

if (-not $PythonExe) {
    foreach ($c in $PythonCandidates) {
        if (Test-Path $c) {
            $PythonExe = $c
            $v = & $c --version 2>&1
            Ok "Python found: $v at $c"
            break
        }
    }
}

if (-not $PythonExe) {
    # Try system PATH
    try {
        $v = & python3 --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $v -match "3\.(11|12)") {
            $PythonExe = "python3"
            Ok "Python found in PATH: $v"
        }
    } catch {}
}

if (-not $PythonExe) {
    Write-Host
    Warn "Python 3.11 not found on this system."
    Write-Host
    Write-Host "  Please install Python 3.11 from one of these sources:" -ForegroundColor Yellow
    Write-Host "    A) python.org  (recommended):" -ForegroundColor Cyan
    Write-Host "       https://www.python.org/downloads/release/python-3119/" -ForegroundColor White
    Write-Host "       Check 'Add Python to PATH' during installation" -ForegroundColor White
    Write-Host
    Write-Host "    B) Microsoft Store: search 'Python 3.11'" -ForegroundColor Cyan
    Write-Host
    Write-Host "    C) winget (if available):" -ForegroundColor Cyan
    Write-Host "       winget install Python.Python.3.11" -ForegroundColor White
    Write-Host
    Read-Host "  After installing, press Enter to re-run this script"
    exit 1
}

# Resolve 'py -3.11' to actual path if needed
if ($PythonExe -eq "py -3.11") {
    $PythonExe = (& py -3.11 -c "import sys; print(sys.executable)").Trim()
}

# ═══════════════════════════════════════════════════════════════════════════════
Step "2/7 · FFmpeg"
# ═══════════════════════════════════════════════════════════════════════════════
$ffmpegFound = $false
try {
    $ffVer = & ffmpeg -version 2>&1 | Select-Object -First 1
    if ($ffVer -match "ffmpeg") { $ffmpegFound = $true; Ok "FFmpeg already installed" }
} catch {}

if (-not $ffmpegFound) {
    Log "Installing FFmpeg via winget..."
    try {
        winget install --id Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + `
                    [System.Environment]::GetEnvironmentVariable("Path","User")
        Ok "FFmpeg installed"
    } catch {
        Warn "winget install failed. Download FFmpeg manually from https://ffmpeg.org/download.html"
        Warn "Place ffmpeg.exe in C:\Windows\System32\ or add its folder to PATH."
        Warn "FFmpeg is optional — voice training will work without it."
    }
}

# ═══════════════════════════════════════════════════════════════════════════════
Step "3/7 · Python Virtual Environment"
# ═══════════════════════════════════════════════════════════════════════════════
if (-not (Test-Path $VenvDir)) {
    Log "Creating virtual environment at $VenvDir ..."
    & $PythonExe -m venv $VenvDir
    Ok "Virtual environment created"
} else {
    Ok "Virtual environment already exists"
}

if (-not (Test-Path $VenvPython)) {
    Err "Virtual environment creation failed. Check that Python 3.11 supports venv."
}

# Copy bundled AI scripts from app resources (when called by Curzon app)
if ($ResourceDir -and (Test-Path (Join-Path $ResourceDir "backend"))) {
    Log "Copying AI engine scripts..."
    Copy-Item (Join-Path $ResourceDir "backend\*.py") $BackendDir -Force -ErrorAction SilentlyContinue
    $vjPath = Join-Path $ResourceDir "backend\voices.json"
    if (Test-Path $vjPath) { Copy-Item $vjPath $BackendDir -Force }
    Ok "AI engine scripts ready"
}

Log "Upgrading pip, setuptools, wheel..."
& $VenvPip install --quiet --upgrade pip setuptools wheel

# ═══════════════════════════════════════════════════════════════════════════════
Step "4/7 · Python Packages"
# ═══════════════════════════════════════════════════════════════════════════════
Log "Installing core audio packages..."
& $VenvPip install --quiet `
    "numpy>=2.0.0" "scipy>=1.11.0" "librosa>=0.10.2" "soundfile>=0.12.1" `
    "pydub>=0.25.1" "noisereduce>=3.0.2" "pedalboard>=0.9.0" `
    "nltk>=3.8.1" "requests>=2.31.0" "tqdm>=4.66.0"
Ok "Core audio packages installed"

Log "Installing ONNX runtime..."
& $VenvPip install --quiet "onnxruntime>=1.18.0"
Ok "ONNX runtime installed"

Log "Installing Kokoro TTS..."
& $VenvPip install --quiet "kokoro-onnx>=0.4.0"
Ok "Kokoro TTS installed"

Log "Installing Piper TTS..."
& $VenvPip install --quiet "piper-tts>=1.2.0"
Ok "Piper TTS installed"

Log "Installing PyTorch CPU (~600 MB)..."
& $VenvPip install --quiet torch torchaudio `
    --index-url https://download.pytorch.org/whl/cpu
Ok "PyTorch installed"

Log "Installing Coqui TTS..."
$env:COQUI_TOS_AGREED = "1"
& $VenvPip install --quiet "TTS>=0.22.0"
Ok "Coqui TTS installed"

Log "Installing F5-TTS..."
& $VenvPip install --quiet "f5-tts>=0.3.0" "cached_path"
Ok "F5-TTS installed"

Log "Installing OpenVoice V2 (from GitHub)..."
try {
    & $VenvPip install --quiet "git+https://github.com/myshell-ai/OpenVoice.git@main#egg=openvoice"
    Ok "OpenVoice installed"
} catch {
    Warn "OpenVoice install had issues — some voice styles may be unavailable"
}

# ═══════════════════════════════════════════════════════════════════════════════
Step "5/7 · NLTK Language Data"
# ═══════════════════════════════════════════════════════════════════════════════
Log "Downloading NLTK tokeniser data..."
$nltkScript = @"
import nltk
for pkg in ('punkt','punkt_tab','averaged_perceptron_tagger','averaged_perceptron_tagger_eng'):
    nltk.download(pkg, quiet=True)
print('NLTK data ready')
"@
& $VenvPython -c $nltkScript
Ok "NLTK data downloaded"

# ═══════════════════════════════════════════════════════════════════════════════
Step "6/8 · Piper Voice Models"
# ═══════════════════════════════════════════════════════════════════════════════
$PiperDir  = Join-Path $BackendDir "models\piper"
New-Item -ItemType Directory -Force -Path $PiperDir | Out-Null
$PiperBase = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

function Download-PiperVoice {
    param([string]$Model, [string]$LangPath)
    $onnxPath = Join-Path $PiperDir "$Model.onnx"
    $jsonPath = Join-Path $PiperDir "$Model.onnx.json"
    if ((Test-Path $onnxPath) -and (Get-Item $onnxPath).Length -gt 100000) {
        Ok "$Model already present"
    } else {
        Log "Downloading $Model..."
        try {
            Invoke-WebRequest -Uri "$PiperBase/$LangPath/$Model.onnx"      -OutFile $onnxPath -UseBasicParsing -ErrorAction Stop
            Invoke-WebRequest -Uri "$PiperBase/$LangPath/$Model.onnx.json" -OutFile $jsonPath -UseBasicParsing -ErrorAction Stop
            Ok "$Model downloaded"
        } catch {
            Warn "$Model download failed — Thorsten/Kerstin voices may not work: $_"
        }
    }
}

Download-PiperVoice -Model "de_DE-thorsten-high" -LangPath "de/de_DE/thorsten/high"
Download-PiperVoice -Model "de_DE-kerstin-low"   -LangPath "de/de_DE/kerstin/low"

# ═══════════════════════════════════════════════════════════════════════════════
Step "7/8 · Kokoro Voice Model  (~100 MB)"
# ═══════════════════════════════════════════════════════════════════════════════
$KokoroDir  = Join-Path $BackendDir "models\kokoro"
$KokoroOnnx = Join-Path $KokoroDir "kokoro-v1.0.onnx"
New-Item -ItemType Directory -Force -Path $KokoroDir | Out-Null

if ((Test-Path $KokoroOnnx) -and (Get-Item $KokoroOnnx).Length -gt 10000000) {
    Ok "Kokoro model already downloaded"
} else {
    Log "Downloading Kokoro ONNX model..."
    try {
        & $VenvPython (Join-Path $BackendDir "download_kokoro.py")
        Ok "Kokoro model downloaded"
    } catch {
        Warn "Kokoro download failed — retry with: python backend\download_kokoro.py"
    }
}

# ═══════════════════════════════════════════════════════════════════════════════
Step "8/8 · OpenVoice V2 Models  (~1.8 GB)"
# ═══════════════════════════════════════════════════════════════════════════════
$OvDir   = Join-Path $BackendDir "openvoice_model"
$OvCkpt  = Join-Path $OvDir "converter\checkpoint.pth"

if ((Test-Path $OvCkpt) -and (Get-Item $OvCkpt).Length -gt 100000000) {
    Ok "OpenVoice V2 models already downloaded"
} else {
    Log "Downloading OpenVoice V2 models (~1.8 GB — please wait)..."
    try {
        & $VenvPython (Join-Path $BackendDir "download_model.py")
        Ok "OpenVoice V2 models downloaded"
    } catch {
        Warn "OpenVoice download failed — the app will prompt you on first launch"
    }
}

# ══════════════════════════════════════════════════════════════════════════════
Write-Host
Sep
Write-Host "  Setup complete!" -ForegroundColor Green
Sep
Write-Host
Write-Host "  What's next:" -ForegroundColor White
Write-Host "   1. Double-click  Curzon.exe  to launch the application"
Write-Host "   2. All voice engines are ready — no internet required"
Write-Host
Write-Host "  If you encounter issues:" -ForegroundColor White
Write-Host "   • Re-run this script — it safely skips completed steps"
Write-Host "   • Ensure  backend\venv\  exists and is populated"
Write-Host
Read-Host "  Press Enter to exit"
