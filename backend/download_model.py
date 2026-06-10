#!/usr/bin/env python3.11
"""
download_model.py – OpenVoice V2 model downloader for VoiceAI (Tauri)

Downloads OpenVoice V2 checkpoints from HuggingFace into:
  <backend_dir>/openvoice_model/checkpoints_v2/

Progress is written to: <backend_dir>/download_progress.json

Skip logic: if all required files already present → writes "already_downloaded"
and exits immediately. Never re-downloads.

Install deps once:
    pip3.11 install openvoice-tts  (or: pip3.11 install git+https://github.com/myshell-ai/OpenVoice)
"""

import sys, os, json, time, urllib.request

SCRIPT_DIR    = os.path.dirname(os.path.abspath(__file__))
PROGRESS_FILE = os.path.join(SCRIPT_DIR, "download_progress.json")
MODEL_DIR     = os.path.join(SCRIPT_DIR, "openvoice_model")

def write_progress(obj: dict):
    obj["ts"] = time.time()
    tmp = PROGRESS_FILE + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(obj, f)
        if os.path.exists(PROGRESS_FILE):
            os.remove(PROGRESS_FILE)
        os.rename(tmp, PROGRESS_FILE)
    except Exception as e:
        sys.stderr.write(f"[download] Cannot write progress: {e}\n")
    sys.stderr.flush()

def err(msg):
    write_progress({"status": "error", "message": msg})
    sys.stderr.write(f"[download] FATAL: {msg}\n"); sys.stderr.flush()
    sys.exit(1)

# OpenVoice V2 files — HuggingFace myshell-ai/OpenVoice
HF_BASE = "https://huggingface.co/myshell-ai/OpenVoice/resolve/main"
MODEL_FILES = [
    ("checkpoints_v2/converter/checkpoint.pth",       350_000_000),
    ("checkpoints_v2/converter/config.json",                5_000),
    ("checkpoints_v2/base_speakers/ses/default.pth",      500_000),
    ("checkpoints_v2/base_speakers/ses/whispering.pth",   500_000),
    ("checkpoints_v2/base_speakers/ses/cheerful.pth",     500_000),
    ("checkpoints_v2/base_speakers/ses/terrified.pth",    500_000),
    ("checkpoints_v2/base_speakers/ses/angry.pth",        500_000),
    ("checkpoints_v2/base_speakers/ses/sad.pth",          500_000),
    ("checkpoints_v2/base_speakers/EN/checkpoint.pth",350_000_000),
    ("checkpoints_v2/base_speakers/EN/config.json",        5_000),
    ("checkpoints_v2/base_speakers/EN/en_default_se.pth", 500_000),
    ("checkpoints_v2/base_speakers/EN/en_style_se.pth",   500_000),
]
TOTAL_BYTES = sum(s for _, s in MODEL_FILES)

def is_complete():
    for rel, min_sz in MODEL_FILES:
        p = os.path.join(MODEL_DIR, rel)
        if not os.path.isfile(p) or os.path.getsize(p) < min_sz:
            sys.stderr.write(f"[download] Missing/incomplete: {p}\n")
            return False
    return True

sys.stderr.write(f"[download] script:   {__file__}\n")
sys.stderr.write(f"[download] progress: {PROGRESS_FILE}\n")
sys.stderr.write(f"[download] model:    {MODEL_DIR}\n")
sys.stderr.write(f"[download] python:   {sys.executable}\n")
sys.stderr.flush()

write_progress({"status": "checking"})

if is_complete():
    sys.stderr.write("[download] OpenVoice V2 already complete.\n")
    write_progress({"status": "already_downloaded", "percent": 100,
                    "mb_done": round(TOTAL_BYTES/1_048_576,1),
                    "mb_total": round(TOTAL_BYTES/1_048_576,1)})
    sys.exit(0)

for rel, _ in MODEL_FILES:
    os.makedirs(os.path.dirname(os.path.join(MODEL_DIR, rel)), exist_ok=True)

write_progress({"status": "downloading", "file": "Preparing...",
                "percent": 0, "mb_done": 0,
                "mb_total": round(TOTAL_BYTES/1_048_576,1), "file_pct": 0})

bytes_total = 0
last_pct    = -1

for rel, min_sz in MODEL_FILES:
    dest = os.path.join(MODEL_DIR, rel)
    tmp  = dest + ".tmp"
    fname = os.path.basename(rel)

    if os.path.isfile(dest) and os.path.getsize(dest) >= min_sz:
        sys.stderr.write(f"[download] Skip: {rel}\n")
        bytes_total += os.path.getsize(dest)
        write_progress({"status": "downloading", "file": fname, "file_pct": 100,
                        "percent": min(int(bytes_total/TOTAL_BYTES*100),99),
                        "mb_done": round(bytes_total/1_048_576,1),
                        "mb_total": round(TOTAL_BYTES/1_048_576,1)})
        continue

    url = f"{HF_BASE}/{rel}"
    sys.stderr.write(f"[download] GET {url}\n"); sys.stderr.flush()

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "VoiceAI/1.0"})
        with urllib.request.urlopen(req, timeout=180) as resp:
            cl = int(resp.headers.get("Content-Length", min_sz))
            bf = 0
            with open(tmp, "wb") as f:
                while True:
                    chunk = resp.read(512*1024)
                    if not chunk: break
                    f.write(chunk)
                    bf          += len(chunk)
                    bytes_total += len(chunk)
                    tp = min(int(bytes_total/TOTAL_BYTES*100), 99)
                    fp = min(int(bf/cl*100), 99)
                    if tp > last_pct:
                        last_pct = tp
                        write_progress({"status": "downloading", "file": fname,
                                        "file_pct": fp, "percent": tp,
                                        "mb_done": round(bytes_total/1_048_576,1),
                                        "mb_total": round(TOTAL_BYTES/1_048_576,1)})
        if os.path.isfile(dest): os.remove(dest)
        os.rename(tmp, dest)
        sys.stderr.write(f"[download] Saved: {dest}\n"); sys.stderr.flush()
    except Exception as e:
        if os.path.isfile(tmp):
            try: os.remove(tmp)
            except: pass
        err(f"Failed to download {rel}: {e}")

write_progress({"status": "done", "percent": 100,
                "mb_done": round(TOTAL_BYTES/1_048_576,1),
                "mb_total": round(TOTAL_BYTES/1_048_576,1)})
sys.stderr.write("[download] OpenVoice V2 complete.\n")
sys.exit(0)
