#!/usr/bin/env python3.11
"""Download Kokoro ONNX model files from GitHub releases."""
import os, sys, json, ssl, urllib.request

# Verify TLS against the certifi CA bundle. Python's stock urllib on a fresh
# Windows box often can't find a local issuer cert (CERTIFICATE_VERIFY_FAILED)
# even though pip / HuggingFace work, because they use certifi while urllib
# does not. requests (a dependency) ships certifi, so it's always present.
try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    _SSL_CTX = ssl.create_default_context()

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR  = os.path.join(SCRIPT_DIR, "models", "kokoro")
os.makedirs(MODEL_DIR, exist_ok=True)

BASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
FILES = {
    "kokoro-v1.0.onnx": f"{BASE_URL}/kokoro-v1.0.onnx",
    "voices-v1.0.bin":  f"{BASE_URL}/voices-v1.0.bin",
}

def _emit(obj):
    print(json.dumps(obj), flush=True)

for name, url in FILES.items():
    path = os.path.join(MODEL_DIR, name)
    if os.path.isfile(path) and os.path.getsize(path) > 100_000:
        _emit({"file": name, "status": "exists"})
        continue
    _emit({"file": name, "status": "downloading"})
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "VoiceAI/1.0"})
        with urllib.request.urlopen(req, timeout=300, context=_SSL_CTX) as r, open(path, "wb") as f:
            total    = int(r.headers.get("Content-Length", 0))
            done     = 0
            last_pct = -1
            while True:
                chunk = r.read(131072)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total > 0:
                    pct = int(done * 100 / total)
                    if pct != last_pct:
                        _emit({"file": name, "status": "progress",
                               "pct": pct, "mb": round(done / 1024 / 1024, 1)})
                        last_pct = pct
        _emit({"file": name, "status": "done"})
    except Exception as e:
        _emit({"file": name, "status": "error", "message": str(e)})
        sys.exit(1)

_emit({"status": "complete"})
