#!/usr/bin/env python3.11
"""
train_voice.py – Voice cloning for VoiceAI (Tauri)

Stores the reference audio and acoustic stats for use by generate.py (XTTS-v2).
No heavyweight embedding extraction needed — XTTS-v2 clones directly from audio.

Called by Rust as:
    python3.11 train_voice.py <audio_path> <voice_name> <gender> <custom_voices_dir>

Outputs JSON to stdout:
    {"status":"ok","id":"...","name":"..."}  or  {"status":"error","message":"..."}
"""

import sys, os, json, time, re

os.environ.pop("PYTHONHASHSEED", None)

# Make a bundled FFmpeg (backend/bin, downloaded by setup.ps1) discoverable to
# pydub so non-WAV reference clips (mp3/m4a/aac/ogg/flac) can be imported.
_FFMPEG_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin")
if os.path.isdir(_FFMPEG_BIN):
    os.environ["PATH"] = _FFMPEG_BIN + os.pathsep + os.environ.get("PATH", "")

def err(msg):
    print(json.dumps({"status": "error", "message": msg}), flush=True)
    sys.exit(1)

if len(sys.argv) < 5:
    err("Usage: train_voice.py <audio_path> <voice_name> <gender> <custom_voices_dir>")

audio_path        = os.path.normpath(sys.argv[1])
voice_name        = sys.argv[2].strip()
gender            = sys.argv[3].strip() if sys.argv[3].strip() in ("Female","Male") else "Male"
custom_voices_dir = os.path.normpath(sys.argv[4].strip())

if not os.path.isfile(audio_path): err(f"Audio file not found: {audio_path}")
if not voice_name:                  err("Voice name cannot be empty")
os.makedirs(custom_voices_dir, exist_ok=True)

def name_to_id(name):
    safe = re.sub(r"[^a-zA-Z0-9_]", "_", name.strip()).lower()
    return f"custom_{safe}_{int(time.time())}"

voice_id  = name_to_id(voice_name)
manifest  = os.path.join(custom_voices_dir, "voices.json")
# ref_wav: the normalized reference audio XTTS-v2 will read at generation time
ref_wav_dest = os.path.join(custom_voices_dir, f"{voice_id}_ref.wav")

# ── Audio conversion + cleaning ───────────────────────────────────────────────
def to_wav_normalized(src, dest):
    """
    Convert any audio to 22050 Hz mono WAV.
    Also applies noise reduction and strips silence so XTTS-v2 conditions on
    clean, continuous speech only — no background noise or dead air baked in.
    """
    try:
        from pydub import AudioSegment
        from pydub.silence import detect_nonsilent
        ext = os.path.splitext(src)[1].lower()
        if   ext == ".wav":              a = AudioSegment.from_wav(src)
        elif ext == ".mp3":              a = AudioSegment.from_mp3(src)
        elif ext in (".m4a", ".aac"):    a = AudioSegment.from_file(src, format="m4a")
        elif ext == ".ogg":              a = AudioSegment.from_ogg(src)
        elif ext == ".flac":             a = AudioSegment.from_file(src, format="flac")
        else:                            a = AudioSegment.from_file(src)

        a = a.set_channels(1).set_frame_rate(22050)

        # ── Step 1: Noise reduction ───────────────────────────────────────────
        # Estimate noise from the quietest frames, then subtract it.
        # prop_decrease=0.75 removes 75% of background noise without
        # introducing processing artifacts on speech.
        try:
            import noisereduce as nr
            import numpy as np, soundfile as _sf, tempfile, io
            raw = np.array(a.get_array_of_samples()).astype(np.float32) / 32768.0
            denoised = nr.reduce_noise(y=raw, sr=22050, stationary=False,
                                       prop_decrease=0.75)
            # Re-normalize after noise reduction (RMS can drop)
            rms_before = np.sqrt(np.mean(raw**2))
            rms_after  = np.sqrt(np.mean(denoised**2))
            if rms_after > 1e-6:
                denoised = denoised * (rms_before / rms_after)
            denoised = np.clip(denoised, -1.0, 1.0)
            pcm = (denoised * 32768).astype(np.int16)
            a = AudioSegment(pcm.tobytes(), frame_rate=22050,
                             sample_width=2, channels=1)
            sys.stderr.write("[train] Noise reduction applied.\n"); sys.stderr.flush()
        except Exception as nr_err:
            sys.stderr.write(f"[train] Noise reduction skipped: {nr_err}\n")

        # ── Step 2: Strip silence — concatenate only speech segments ──────────
        # Silence between phrases contains noise that XTTS-v2 picks up.
        # Replace it with short (150 ms) clean gaps.
        try:
            chunks = detect_nonsilent(a, min_silence_len=300, silence_thresh=-40)
            if chunks and len(chunks) > 1:
                gap = AudioSegment.silent(duration=150, frame_rate=22050)
                parts = []
                for s, e in chunks:
                    seg = a[s:e]
                    if len(seg) >= 500:   # skip very short clicks
                        parts.append(seg)
                if len(parts) >= 2:
                    combined = parts[0]
                    for p in parts[1:]:
                        combined = combined + gap + p
                    original_dur = len(a) / 1000.0
                    new_dur      = len(combined) / 1000.0
                    a = combined
                    sys.stderr.write(
                        f"[train] Silence stripped: {original_dur:.1f}s → {new_dur:.1f}s "
                        f"({len(parts)} speech segments kept)\n"
                    )
                    sys.stderr.flush()
        except Exception as ss_err:
            sys.stderr.write(f"[train] Silence stripping skipped: {ss_err}\n")

        # ── Step 3: Final loudness normalization ──────────────────────────────
        target_dBFS = -20.0
        delta = target_dBFS - a.dBFS
        if abs(delta) < 30:
            a = a.apply_gain(delta)

        a.export(dest, format="wav")
        return len(a) / 1000.0   # duration in seconds
    except Exception as e:
        err(f"Audio conversion failed: {e}")

sys.stderr.write("[train] Converting, denoising, and normalizing audio...\n"); sys.stderr.flush()
dur = to_wav_normalized(audio_path, ref_wav_dest)
sys.stderr.write(f"[train] Duration: {dur:.1f}s → saved to {ref_wav_dest}\n"); sys.stderr.flush()

if dur < 6:
    os.remove(ref_wav_dest)
    err(f"Audio too short ({dur:.1f}s). Minimum 6 s; 15–30 s recommended for XTTS-v2.")

# ── Measure reference voice stats ─────────────────────────────────────────────
def measure_voice_stats(wav_path):
    import warnings; warnings.filterwarnings("ignore")
    import numpy as np
    try:
        import librosa
        y, sr = librosa.load(wav_path, sr=None)
        dur_s = len(y) / sr

        f0, voiced_flag, _ = librosa.pyin(y, fmin=60, fmax=500, sr=sr, frame_length=2048)
        f0_voiced = f0[voiced_flag & ~np.isnan(f0)]
        f0_mean = float(np.mean(f0_voiced)) if len(f0_voiced) > 5 else 0.0
        f0_std  = float(np.std(f0_voiced))  if len(f0_voiced) > 5 else 0.0

        # Syllable rate over voiced frames only (silence-robust)
        voiced_ratio  = float(np.sum(voiced_flag)) / len(voiced_flag) if len(voiced_flag) > 0 else 0.5
        voiced_dur    = max(dur_s * voiced_ratio, 0.5)
        onset_times   = librosa.onset.onset_detect(
            y=y, sr=sr, units="time",
            pre_max=20, post_max=20, pre_avg=100, post_avg=100, delta=0.07, wait=10
        )
        syllable_rate = len(onset_times) / voiced_dur

        # Spectral brightness (centroid) — used by generate.py for EQ matching
        freqs = np.fft.rfftfreq(len(y), 1.0 / sr)
        mag   = np.abs(np.fft.rfft(y)) + 1e-12
        spec_brightness = float(np.sum(freqs * mag) / np.sum(mag))

        sys.stderr.write(
            f"[train] Voice stats — F0: {f0_mean:.1f}±{f0_std:.1f} Hz, "
            f"rate: {syllable_rate:.2f} syl/s (over {voiced_dur:.1f}s voiced), "
            f"brightness: {spec_brightness:.0f} Hz\n"
        )
        return {
            "f0_mean":            round(f0_mean, 1),
            "f0_std":             round(f0_std, 1),
            "syllable_rate":      round(syllable_rate, 2),
            "duration_sec":       round(dur_s, 2),
            "spectral_brightness": round(spec_brightness, 1),
        }
    except Exception as ex:
        sys.stderr.write(f"[train] Stats measurement skipped: {ex}\n")
        return {}

ref_stats = measure_voice_stats(ref_wav_dest)

# ── Transcribe reference audio (stored so F5-TTS skips Whisper at gen time) ──
ref_text = ""
try:
    import torch
    from f5_tts.infer.utils_infer import transcribe
    ref_text = transcribe(ref_wav_dest).strip()
    sys.stderr.write(f"[train] Transcribed ref_text: {ref_text[:80]}\n")
except Exception as te:
    sys.stderr.write(f"[train] Transcription skipped (non-fatal): {te}\n")

# ── Update voices.json ────────────────────────────────────────────────────────
try:
    existing = []
    if os.path.isfile(manifest):
        with open(manifest, "r", encoding="utf-8") as f:
            existing = json.load(f)
    existing = [v for v in existing if v.get("name") != voice_name]
    entry = {
        "id":       voice_id,
        "name":     voice_name,
        "gender":   gender,
        "ref_wav":  os.path.basename(ref_wav_dest),
        "ref_text": ref_text,
        "created":  int(time.time()),
        "engine":   f"f5tts|{voice_id}",
    }
    if ref_stats:
        entry["ref_stats"] = ref_stats
    existing.append(entry)
    with open(manifest, "w", encoding="utf-8") as f:
        json.dump(existing, f, indent=2, ensure_ascii=False)
    sys.stderr.write("[train] Manifest updated.\n")
except Exception as e:
    err(f"Failed to save manifest: {e}")

sys.stderr.write("[train] Done. Reference audio stored for XTTS-v2 generation.\n")
print(json.dumps({"status": "ok", "id": voice_id, "name": voice_name}), flush=True)
sys.exit(0)
