#!/usr/bin/env python3.11
"""
generate.py – Offline TTS backend for VoiceAI (Tauri)

Engine string formats:
  "tts_models/en/vctk/vits|p225"          → VCTK VITS
  "tts_models/en/ljspeech/tacotron2-DDC"  → LJSpeech
  "openvoice_v2|<voice_id>|<voices_dir>"  → OpenVoice V2 cloned voice

Called by Rust as:
  python3.11 generate.py <text> <engine> <emotion> <speed> <pitch> <volume> <style_strength> <trim_silence>

Outputs basename of generated WAV to stdout on success.
"""

import sys, os, time, warnings
import numpy as np
warnings.filterwarnings("ignore")

# F5-TTS spawns torch multiprocessing workers (spawn method on macOS) that
# inherit all env vars. If PYTHONHASHSEED is set to anything invalid those
# workers die immediately. Unset it here so subprocesses start clean.
os.environ.pop("PYTHONHASHSEED", None)

if len(sys.argv) < 9:
    print("Usage: generate.py <text> <engine> <emotion> <speed> <pitch> <volume> <style_strength> <trim_silence> [mastering]")
    sys.exit(1)

text           = sys.argv[1]
engine_raw     = sys.argv[2]
emotion        = float(sys.argv[3])
speed          = float(sys.argv[4])
pitch_st       = float(sys.argv[5])
volume_pct     = float(sys.argv[6])
style_strength = float(sys.argv[7])
trim_silence   = sys.argv[8] == "1"
mastering      = sys.argv[9] if len(sys.argv) > 9 else "none"

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
HISTORY_DIR = os.path.join(SCRIPT_DIR, "history")
os.makedirs(HISTORY_DIR, exist_ok=True)

timestamp = time.strftime("%Y%m%d_%H%M%S")
out_path  = os.path.join(HISTORY_DIR, f"voice_{timestamp}.wav")

# ── Post-processing (shared with f5_worker.py) ────────────────────────────────
from audio_post import pitch_shift_wav, apply_volume, master_audio, trim_silence_fn

# ── Route: Kokoro-ONNX ────────────────────────────────────────────────────────
if engine_raw.startswith("kokoro|"):
    parts        = engine_raw.split("|")
    kokoro_voice = parts[1]
    kokoro_lang  = parts[2] if len(parts) > 2 else "en-us"
    # Map UI lang codes → espeak lang codes
    _LANG_MAP = {"zh": "cmn", "zh-cn": "cmn", "zh-tw": "cmn"}
    kokoro_lang = _LANG_MAP.get(kokoro_lang, kokoro_lang)
    KOKORO_DIR   = os.path.join(SCRIPT_DIR, "models", "kokoro")
    model_path   = os.path.join(KOKORO_DIR, "kokoro-v1.0.onnx")
    voices_path  = os.path.join(KOKORO_DIR, "voices-v1.0.bin")
    if not os.path.isfile(model_path):
        print("Kokoro model not downloaded. Open Settings > Download Kokoro Model first.")
        sys.exit(1)
    try:
        from kokoro_onnx import Kokoro as _KokoroTTS
        _kok = _KokoroTTS(model_path, voices_path)
        samples, sample_rate = _kok.create(text, voice=kokoro_voice, speed=speed, lang=kokoro_lang)
        import soundfile as _sf
        _sf.write(out_path, samples, sample_rate)
        sys.stderr.write(f"[generate] Kokoro voice={kokoro_voice} lang={kokoro_lang}\n")
    except ImportError:
        print("kokoro-onnx not installed. Run: pip install kokoro-onnx soundfile")
        sys.exit(1)
    except Exception as _ke:
        import traceback
        print(f"Kokoro error: {_ke}\n{traceback.format_exc()}")
        sys.exit(1)

# ── Route: Piper ONNX (German & other languages) ──────────────────────────────
elif engine_raw.startswith("piper|"):
    _piper_model_id = engine_raw.split("|", 1)[1]
    _piper_dir  = os.path.join(SCRIPT_DIR, "models", "piper")
    _piper_path = os.path.join(_piper_dir, f"{_piper_model_id}.onnx")
    if not os.path.isfile(_piper_path):
        print(f"Piper model not found: {_piper_path}")
        sys.exit(1)
    try:
        import wave as _wave, io as _io
        from piper.voice import PiperVoice as _PiperVoice
        _pv = _PiperVoice.load(_piper_path)
        _buf = _io.BytesIO()
        with _wave.open(_buf, "wb") as _wf:
            _pv.synthesize_wav(text, _wf)
        import soundfile as _sf2
        _buf.seek(0)
        with _wave.open(_buf, "rb") as _wr:
            _sr = _wr.getframerate()
            _frames = _wr.readframes(_wr.getnframes())
        import numpy as _np2
        _audio = _np2.frombuffer(_frames, dtype=_np2.int16).astype(_np2.float32) / 32768.0
        if abs(speed - 1.0) > 0.05:
            try:
                import librosa as _lr
                _audio = _lr.effects.time_stretch(_audio, rate=speed)
            except Exception:
                pass
        _sf2.write(out_path, _audio, _sr)
        sys.stderr.write(f"[generate] Piper model={_piper_model_id}\n")
    except ImportError:
        print("piper-tts not installed. Run: pip3.11 install piper-tts")
        sys.exit(1)
    except Exception as _pe:
        import traceback
        print(f"Piper error: {_pe}\n{traceback.format_exc()}")
        sys.exit(1)

# ── Route: F5-TTS custom voice ─────────────────────────────────────────────────
elif engine_raw.startswith("f5tts|"):
    parts     = engine_raw.split("|")
    _vid      = parts[1]
    _vdir     = parts[2] if len(parts) > 2 else os.path.join(SCRIPT_DIR, "custom_voices")
    import json as _j2
    _manifest = os.path.join(_vdir, "voices.json")
    if not os.path.isfile(_manifest):
        print(f"Custom voices manifest not found: {_manifest}"); sys.exit(1)
    with open(_manifest) as _mf:
        _vlist = _j2.load(_mf)
    _ve = next((v for v in _vlist if v.get("id") == _vid), None)
    if not _ve:
        print(f"Voice '{_vid}' not found in manifest"); sys.exit(1)
    _ref_wav  = os.path.join(_vdir, _ve["ref_wav"])
    _ref_text = _ve.get("ref_text", "")
    if not os.path.isfile(_ref_wav):
        print(f"Reference audio not found: {_ref_wav}"); sys.exit(1)
    try:
        import torch as _torch
        if _torch.backends.mps.is_available():
            _f5_device = "mps"
        elif _torch.cuda.is_available():
            _f5_device = "cuda"
        else:
            _f5_device = "cpu"
        from f5_tts.api import F5TTS as _F5TTS
        _f5 = _F5TTS(model="F5TTS_v1_Base", device=_f5_device)
        # F5-TTS generates ~20% fast at speed=1.0 vs natural listening pace.
        # Apply correction only when user hasn't moved the slider.
        _f5_speed = 0.82 if speed == 1.0 else speed
        _f5.infer(
            ref_file=_ref_wav, ref_text=_ref_text, gen_text=text,
            file_wave=out_path, speed=_f5_speed, nfe_step=16,
        )
        sys.stderr.write(f"[generate] F5-TTS voice={_vid} device={_f5_device} speed={_f5_speed}\n")
    except ImportError:
        print("f5-tts not installed. Run: pip install f5-tts"); sys.exit(1)
    except Exception as _f5e:
        import traceback
        print(f"F5-TTS error: {_f5e}\n{traceback.format_exc()}"); sys.exit(1)

# ── Route: standard Coqui TTS (VCTK, LJSpeech, etc.) ─────────────────────────
else:  # tts_models/...
    model_name, speaker_id = (engine_raw.split("|",1) + [None])[:2] if "|" in engine_raw else (engine_raw, None)
    try:
        import shutil
        from TTS.api import TTS

        def _clear_zip_only_caches():
            """Wipe every TTS cache dir that contains only .zip files.
            A zip-only dir means the download finished but extraction failed —
            this affects both the main model and any dependent vocoder."""
            for tts_root in [
                os.path.join(os.path.expanduser("~"), "Library", "Application Support", "tts"),
                os.path.join(os.path.expanduser("~"), ".local", "share", "tts"),
            ]:
                if not os.path.isdir(tts_root):
                    continue
                for entry in os.listdir(tts_root):
                    entry_path = os.path.join(tts_root, entry)
                    if not os.path.isdir(entry_path):
                        continue
                    contents = os.listdir(entry_path)
                    if contents and all(f.endswith(".zip") for f in contents):
                        sys.stderr.write(f"[generate] Corrupted cache (zip-only): {entry_path} — clearing\n")
                        shutil.rmtree(entry_path, ignore_errors=True)

        def _load_tts_model(name):
            """Load TTS model; auto-clears all corrupted caches (model + vocoder) and retries once."""
            try:
                return TTS(model_name=name, progress_bar=False, gpu=False)
            except ValueError as ve:
                if "Model file not found" not in str(ve):
                    raise
                # Wipe ALL zip-only dirs — catches main model and any dependent vocoder
                _clear_zip_only_caches()
                sys.stderr.write(f"[generate] Re-downloading {name}...\n")
                return TTS(model_name=name, progress_bar=False, gpu=False)

        tts = _load_tts_model(model_name)

        # Speed calibration per model:
        #   VCTK VITS      : runs ~18% fast at speed=1.0 → correct to 0.82
        #   LJSpeech models: runs ~8% fast at speed=1.0  → correct to 0.92
        #   Correction only applies when user hasn't moved the slider (speed==1.0)
        effective_speed = speed
        if abs(speed - 1.0) < 0.01:
            if "vctk" in model_name:
                effective_speed = 0.82
            elif "ljspeech" in model_name:
                effective_speed = 0.92

        # Strip app-internal prefixes before passing speaker ID to Coqui.
        # App uses "vctk_p335" internally but Coqui expects just "p335".
        clean_speaker_id = None
        if speaker_id:
            if speaker_id.startswith("vctk_"):
                clean_speaker_id = speaker_id[len("vctk_"):]
            elif speaker_id.startswith("ljspeech_"):
                clean_speaker_id = None   # single-speaker models need no ID
            else:
                clean_speaker_id = speaker_id

        sys.stderr.write(
            f"[generate] model={model_name} speaker={clean_speaker_id} "
            f"speed={effective_speed} (requested={speed})\n"
        )
        sys.stderr.flush()

        kwargs = dict(text=text, file_path=out_path, speed=effective_speed)
        if clean_speaker_id:
            kwargs["speaker"] = clean_speaker_id
        tts.tts_to_file(**kwargs)
    except Exception as e:
        import traceback
        msg = f"TTS error: {e}\n{traceback.format_exc()}"
        sys.stderr.write(msg + "\n")
        print(msg)
        sys.exit(1)

# ── Post-processing ───────────────────────────────────────────────────────────
if pitch_st != 0:  pitch_shift_wav(out_path, pitch_st)
if volume_pct != 80: apply_volume(out_path, volume_pct)
if trim_silence:   trim_silence_fn(out_path)
master_audio(out_path, mastering)

print(os.path.basename(out_path))
sys.exit(0)
