#!/usr/bin/env python3.11
"""
f5_worker.py – Persistent F5-TTS generation worker for VoiceAI (Tauri).

Loading the ~1.2 GB F5-TTS model takes 10-15 s. generate.py paid that cost on
every single click because Rust spawned a fresh subprocess each time. This
worker is started once and stays resident: the model is loaded a single time,
then each generation request only pays for inference.

Protocol (one JSON object per line, newline-delimited):
  Rust → worker (stdin):
    {"text": "...", "voice_id": "...", "voices_dir": "...",
     "speed": 1.0, "pitch": 0.0, "volume": 80.0,
     "trim_silence": false, "mastering": "none"}
  worker → Rust (stdout):
    {"status": "ready"}                          (once, after model load)
    {"status": "ok", "file": "voice_2026....wav"}  (per request)
    {"status": "error", "message": "..."}          (per request)

Everything that is NOT protocol goes to stderr so stdout stays clean.
"""

import sys, os, json, time, warnings
warnings.filterwarnings("ignore")

# F5-TTS spawns torch multiprocessing workers (spawn method on macOS) that
# inherit env vars. A stale/invalid PYTHONHASHSEED kills those workers. Unset
# it here so subprocesses start clean.
os.environ.pop("PYTHONHASHSEED", None)

# ── Protocol channel isolation ────────────────────────────────────────────────
# F5-TTS and its dependencies (torch, tqdm, pydub) print progress such as
# "Converting audio..." to stdout. The parent reads stdout as a strict
# line-delimited JSON protocol, so any stray print corrupts a response.
# Duplicate the real stdout onto a private fd used ONLY for protocol messages,
# then point fd 1 (and Python's sys.stdout) at stderr so every library print is
# harmless noise on stderr instead of protocol corruption.
_protocol = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
HISTORY_DIR = os.path.join(SCRIPT_DIR, "history")
os.makedirs(HISTORY_DIR, exist_ok=True)

# Make audio_post importable regardless of cwd.
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
from audio_post import apply_post


def log(msg):
    sys.stderr.write(f"[f5_worker] {msg}\n")
    sys.stderr.flush()


def emit(obj):
    """Write a single protocol line to the private protocol channel."""
    _protocol.write(json.dumps(obj) + "\n")
    _protocol.flush()


# ── Load model once ───────────────────────────────────────────────────────────
log("Starting — loading F5-TTS model (one-time)...")
try:
    import torch
    if torch.backends.mps.is_available():
        DEVICE = "mps"
    elif torch.cuda.is_available():
        DEVICE = "cuda"
    else:
        DEVICE = "cpu"
    from f5_tts.api import F5TTS
    F5 = F5TTS(model="F5TTS_v1_Base", device=DEVICE)
    log(f"Model loaded on device={DEVICE}")
except Exception as e:
    import traceback
    log(f"Fatal: could not load F5-TTS model: {e}\n{traceback.format_exc()}")
    emit({"status": "fatal", "message": str(e)})
    sys.exit(1)

# Signal readiness — Rust blocks until it sees this line.
emit({"status": "ready"})


# ── Resolve a voice entry from its manifest ───────────────────────────────────
_manifest_cache = {}

def resolve_voice(voice_id, voices_dir):
    manifest = os.path.join(voices_dir, "voices.json")
    if not os.path.isfile(manifest):
        raise FileNotFoundError(f"Custom voices manifest not found: {manifest}")
    mtime = os.path.getmtime(manifest)
    cached = _manifest_cache.get(manifest)
    if not cached or cached[0] != mtime:
        with open(manifest) as mf:
            _manifest_cache[manifest] = (mtime, json.load(mf))
    vlist = _manifest_cache[manifest][1]
    ve = next((v for v in vlist if v.get("id") == voice_id), None)
    if not ve:
        raise KeyError(f"Voice '{voice_id}' not found in manifest")
    ref_wav = os.path.join(voices_dir, ve["ref_wav"])
    if not os.path.isfile(ref_wav):
        raise FileNotFoundError(f"Reference audio not found: {ref_wav}")
    return ref_wav, ve.get("ref_text", "")


# ── Handle one generation request ─────────────────────────────────────────────
def handle(req):
    text         = req["text"]
    voice_id     = req["voice_id"]
    voices_dir   = req.get("voices_dir") or os.path.join(SCRIPT_DIR, "custom_voices")
    speed        = float(req.get("speed", 1.0))
    pitch_st     = float(req.get("pitch", 0.0))
    volume_pct   = float(req.get("volume", 80.0))
    trim_silence = bool(req.get("trim_silence", False))
    mastering    = req.get("mastering", "none")

    ref_wav, ref_text = resolve_voice(voice_id, voices_dir)

    timestamp = time.strftime("%Y%m%d_%H%M%S")
    out_path  = os.path.join(HISTORY_DIR, f"voice_{timestamp}.wav")

    # F5-TTS generates ~20% fast at speed=1.0 vs natural listening pace.
    # Apply the same correction generate.py used when the slider is untouched.
    f5_speed = 0.82 if speed == 1.0 else speed

    t0 = time.time()
    F5.infer(
        ref_file=ref_wav, ref_text=ref_text, gen_text=text,
        file_wave=out_path, speed=f5_speed, nfe_step=16,
    )
    log(f"Inference voice={voice_id} speed={f5_speed} took {time.time()-t0:.1f}s")

    apply_post(out_path, pitch_st=pitch_st, volume_pct=volume_pct,
               trim_silence=trim_silence, mastering=mastering)

    return os.path.basename(out_path)


# ── Main loop ─────────────────────────────────────────────────────────────────
log("Ready for requests.")
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception as e:
        emit({"status": "error", "message": f"Bad request JSON: {e}"})
        continue
    try:
        fname = handle(req)
        emit({"status": "ok", "file": fname})
    except Exception as e:
        import traceback
        log(f"Generation error: {e}\n{traceback.format_exc()}")
        emit({"status": "error", "message": str(e)})

log("stdin closed — exiting.")
