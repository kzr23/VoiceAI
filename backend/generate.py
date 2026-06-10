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

# ── Post-processing ───────────────────────────────────────────────────────────
def pitch_shift_wav(path, semitones):
    if abs(semitones) < 0.01: return
    try:
        import librosa, soundfile as sf
        y, sr = librosa.load(path, sr=None)
        y_shifted = librosa.effects.pitch_shift(y, sr=sr, n_steps=float(semitones))
        sf.write(path, y_shifted, sr)
    except Exception:
        try:  # fallback: pydub frame-rate trick
            from pydub import AudioSegment
            a = AudioSegment.from_wav(path)
            f = 2 ** (semitones / 12.0)
            a._spawn(a.raw_data, overrides={"frame_rate": int(a.frame_rate * f)}).set_frame_rate(a.frame_rate).export(path, format="wav")
        except Exception: pass

def apply_volume(path, vol_pct):
    if abs(vol_pct - 80.0) < 0.5: return
    try:
        from pydub import AudioSegment
        a = AudioSegment.from_wav(path)
        (a + 20 * np.log10(max(vol_pct,1)/80.0)).export(path, format="wav")
    except Exception: pass

def master_audio(path, preset):
    if not preset or preset == "none":
        return
    try:
        import soundfile as _sf2
        import numpy as _np2
        from pedalboard import (Pedalboard, NoiseGate, Compressor, HighpassFilter,
                                PeakFilter, Limiter, Reverb, LowShelfFilter, HighShelfFilter)
        audio, sr = _sf2.read(path)
        pb = audio.astype(_np2.float32)
        if pb.ndim == 1:
            pb = pb.reshape(1, -1)
        else:
            pb = pb.T
        if preset == "podcast":
            board = Pedalboard([
                NoiseGate(threshold_db=-40, ratio=1.5, attack_ms=1.0, release_ms=100.0),
                HighpassFilter(cutoff_frequency_hz=80.0),
                Compressor(threshold_db=-20.0, ratio=3.0, attack_ms=5.0, release_ms=100.0),
                PeakFilter(cutoff_frequency_hz=3000.0, gain_db=2.5, q=0.7),
                Limiter(threshold_db=-1.0, release_ms=100.0),
            ])
        elif preset == "audiobook":
            board = Pedalboard([
                NoiseGate(threshold_db=-45, ratio=1.3, attack_ms=2.0, release_ms=150.0),
                HighpassFilter(cutoff_frequency_hz=60.0),
                Compressor(threshold_db=-18.0, ratio=2.0, attack_ms=10.0, release_ms=150.0),
                LowShelfFilter(cutoff_frequency_hz=200.0, gain_db=1.5),
                Reverb(room_size=0.12, damping=0.7, wet_level=0.07, dry_level=0.93),
                Limiter(threshold_db=-1.0, release_ms=100.0),
            ])
        elif preset == "broadcast":
            board = Pedalboard([
                NoiseGate(threshold_db=-35, ratio=2.0, attack_ms=1.0, release_ms=80.0),
                HighpassFilter(cutoff_frequency_hz=100.0),
                Compressor(threshold_db=-15.0, ratio=4.0, attack_ms=3.0, release_ms=80.0),
                HighShelfFilter(cutoff_frequency_hz=8000.0, gain_db=1.5),
                PeakFilter(cutoff_frequency_hz=2500.0, gain_db=3.0, q=0.8),
                Limiter(threshold_db=-0.5, release_ms=50.0),
            ])
        else:
            return
        out = board(pb, sr)
        _sf2.write(path, out[0] if audio.ndim == 1 else out.T, sr)
        sys.stderr.write(f"[generate] Mastering preset={preset}\n")
    except Exception as _me:
        sys.stderr.write(f"[generate] Mastering skipped: {_me}\n")

def trim_silence_fn(path):
    try:
        from pydub import AudioSegment
        from pydub.silence import detect_leading_silence
        a = AudioSegment.from_wav(path)
        s = detect_leading_silence(a, silence_threshold=-40)
        e = detect_leading_silence(a.reverse(), silence_threshold=-40)
        a[s:len(a)-e].export(path, format="wav")
    except Exception: pass

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

# ── Route: custom cloned voice (XTTS-v2 primary, OpenVoice V2 legacy fallback) ─
elif engine_raw.startswith("openvoice_v2|"):
    parts = engine_raw.split("|")
    if len(parts) < 3:
        print("engine must be: openvoice_v2|<voice_id>|<voices_dir>")
        sys.exit(1)

    voice_id   = parts[1]
    voices_dir = parts[2]

    import json as _json
    voice_entry  = {}
    ref_wav_path = None
    emb_pth      = os.path.join(voices_dir, f"{voice_id}.pth")
    emb_npy      = os.path.join(voices_dir, f"{voice_id}.npy")

    manifest = os.path.join(voices_dir, "voices.json")
    if os.path.isfile(manifest):
        with open(manifest) as mf:
            for v in _json.load(mf):
                if v.get("id") == voice_id:
                    voice_entry = v
                    if v.get("ref_wav"):
                        candidate = os.path.join(voices_dir, v["ref_wav"])
                        if os.path.isfile(candidate):
                            ref_wav_path = candidate
                    if v.get("embedding"):
                        emb_file = os.path.join(voices_dir, v["embedding"])
                        if emb_file.endswith(".pth"): emb_pth = emb_file
                        else:                         emb_npy = emb_file
                    break

    # ══════════════════════════════════════════════════════════════════════════
    # Path A: XTTS-v2 — uses the stored reference audio directly.
    # Clones accent, pitch, rhythm, and timbre in one shot.
    # ══════════════════════════════════════════════════════════════════════════
    if ref_wav_path:
        try:
            import os as _os
            _os.environ["COQUI_TOS_AGREED"] = "1"

            import torch as _torch
            _orig_torch_load = _torch.load
            def _torch_load_compat(*a, **kw):
                kw.setdefault("weights_only", False)
                return _orig_torch_load(*a, **kw)
            _torch.load = _torch_load_compat

            ref_stats    = voice_entry.get("ref_stats", {})
            ref_f0_mean  = ref_stats.get("f0_mean", 0.0)
            ref_bright   = ref_stats.get("spectral_brightness", 0.0)

            # ── Clean the reference audio before conditioning ─────────────────
            # Apply noise reduction + silence stripping at generation time so
            # even voices trained before the denoising pipeline get clean input.
            def _clean_ref_for_xtts(ref_path):
                try:
                    import tempfile, numpy as _np
                    import noisereduce as _nr
                    from pydub import AudioSegment as _PA
                    from pydub.silence import detect_nonsilent as _dns

                    a = _PA.from_wav(ref_path).set_channels(1).set_frame_rate(22050)

                    # Noise reduction
                    raw = _np.array(a.get_array_of_samples()).astype(_np.float32) / 32768.0
                    denoised = _nr.reduce_noise(y=raw, sr=22050,
                                                stationary=False, prop_decrease=0.75)
                    rms_b = _np.sqrt(_np.mean(raw**2))
                    rms_a = _np.sqrt(_np.mean(denoised**2))
                    if rms_a > 1e-6:
                        denoised = denoised * (rms_b / rms_a)
                    denoised = _np.clip(denoised, -1.0, 1.0)
                    pcm = (denoised * 32768).astype(_np.int16)
                    a = _PA(pcm.tobytes(), frame_rate=22050, sample_width=2, channels=1)

                    # Strip silence — concatenate speech only with 120ms gaps
                    chunks = _dns(a, min_silence_len=300, silence_thresh=-40)
                    parts  = [a[s:e] for s, e in chunks if (e - s) >= 800]
                    if len(parts) >= 2:
                        gap   = _PA.silent(duration=120, frame_rate=22050)
                        clean = parts[0]
                        for p in parts[1:]:
                            clean = clean + gap + p
                        a = clean

                    # Re-normalize
                    delta = -20.0 - a.dBFS
                    if abs(delta) < 30:
                        a = a.apply_gain(delta)

                    tmp = tempfile.mkdtemp()
                    clean_path = os.path.join(tmp, "ref_clean.wav")
                    a.export(clean_path, format="wav")
                    sys.stderr.write(
                        f"[generate] Ref cleaned: {len(a)/1000:.1f}s "
                        f"({len(parts)} segments, noise reduced)\n"
                    )
                    return clean_path, tmp
                except Exception as _ce:
                    sys.stderr.write(f"[generate] Ref cleaning skipped: {_ce}\n")
                    return ref_path, None

            clean_ref_path, _tmp_clean_dir = _clean_ref_for_xtts(ref_wav_path)
            sys.stderr.write(f"[generate] XTTS-v2: ref F0={ref_f0_mean:.1f} Hz\n")
            sys.stderr.flush()

            from TTS.api import TTS
            tts_model = TTS(
                model_name="tts_models/multilingual/multi-dataset/xtts_v2",
                progress_bar=False,
                gpu=False,
            )
            tts_model.tts_to_file(
                text=text,
                speaker_wav=clean_ref_path,
                language="en",
                file_path=out_path,
                speed=speed,
                temperature=0.65,            # Coqui's quality-optimised default
                repetition_penalty=10.0,
                top_k=50,
                top_p=0.85,
                enable_text_splitting=True,  # generate sentence-by-sentence → clear pronunciation
            )

            # Cleanup
            if _tmp_clean_dir:
                import shutil
                try: shutil.rmtree(_tmp_clean_dir)
                except Exception: pass

            _torch.load = _orig_torch_load

            # Auto pitch correction — XTTS-v2 often generates slightly lower
            # than the reference. Measure the delta and correct it (≤3 st safe zone).
            if ref_f0_mean > 60:
                try:
                    import librosa as _lib, numpy as _np
                    y_g, sr_g = _lib.load(out_path, sr=None)
                    f0_g, v_g, _ = _lib.pyin(y_g, fmin=60, fmax=500, sr=sr_g, frame_length=2048)
                    f0_voiced = f0_g[v_g & ~_np.isnan(f0_g)]
                    if len(f0_voiced) > 10:
                        gen_f0  = float(_np.mean(f0_voiced))
                        st_raw  = float(12 * _np.log2(ref_f0_mean / gen_f0))
                        st_safe = max(-3.0, min(3.0, st_raw))
                        if abs(st_safe) > 0.25:
                            pitch_shift_wav(out_path, st_safe)
                            sys.stderr.write(
                                f"[generate] Pitch corrected: {gen_f0:.1f}→"
                                f"{ref_f0_mean:.1f} Hz ({st_safe:+.2f} st)\n"
                            )
                except Exception as _pe:
                    sys.stderr.write(f"[generate] Pitch correction skipped: {_pe}\n")

            # Spectral brightness matching — resample both to a common rate (22050)
            # before comparing centroids, then apply a high-shelf boost/cut.
            if ref_bright > 500:
                try:
                    import librosa as _lib, numpy as _np, soundfile as _sf
                    from scipy.signal import sosfilt
                    # Load generated at 22050 so comparison is on the same scale
                    y_g22, _ = _lib.load(out_path, sr=22050)
                    freqs22  = _np.fft.rfftfreq(len(y_g22), 1.0 / 22050)
                    mag22    = _np.abs(_np.fft.rfft(y_g22)) + 1e-12
                    gen_bright22 = float(_np.sum(freqs22 * mag22) / _np.sum(mag22))
                    delta_hz = ref_bright - gen_bright22
                    # Only apply if gap > 80 Hz; limit to ±4 dB shelf gain
                    if abs(delta_hz) > 80:
                        shelf_gain_db = max(-4.0, min(4.0, delta_hz / 120.0))
                        # Apply EQ on the native-rate file to avoid re-sample quality loss
                        y_g, sr_g = _lib.load(out_path, sr=None)
                        shelf_hz = 3000.0
                        A  = 10 ** (shelf_gain_db / 40.0)
                        w0 = 2 * _np.pi * shelf_hz / sr_g
                        alpha = _np.sin(w0) / 2 * _np.sqrt(2)
                        b0 =      A*((A+1) + (A-1)*_np.cos(w0) + 2*_np.sqrt(A)*alpha)
                        b1 = -2*A*((A-1) + (A+1)*_np.cos(w0))
                        b2 =      A*((A+1) + (A-1)*_np.cos(w0) - 2*_np.sqrt(A)*alpha)
                        a0 =         (A+1) - (A-1)*_np.cos(w0) + 2*_np.sqrt(A)*alpha
                        a1 =    2*( (A-1) - (A+1)*_np.cos(w0))
                        a2 =         (A+1) - (A-1)*_np.cos(w0) - 2*_np.sqrt(A)*alpha
                        sos = _np.array([[b0/a0, b1/a0, b2/a0, 1.0, a1/a0, a2/a0]])
                        y_eq = sosfilt(sos, y_g)
                        peak = _np.max(_np.abs(y_eq))
                        if peak > 0: y_eq = y_eq / peak * _np.max(_np.abs(y_g))
                        _sf.write(out_path, y_eq.astype(_np.float32), sr_g)
                        sys.stderr.write(
                            f"[generate] Brightness EQ: {gen_bright22:.0f}→"
                            f"~{ref_bright:.0f} Hz ({shelf_gain_db:+.1f} dB shelf)\n"
                        )
                except Exception as _be:
                    sys.stderr.write(f"[generate] Brightness EQ skipped: {_be}\n")

            sys.stderr.write(f"[generate] Saved: {out_path}\n")

        except Exception as e:
            import traceback
            print(f"XTTS-v2 generation error: {e}\n{traceback.format_exc()}")
            sys.exit(1)

    # ══════════════════════════════════════════════════════════════════════════
    # Path B: OpenVoice V2 legacy — for voices trained before XTTS-v2 switch.
    # Uses the stored .pth embedding with F0-matched VCTK base speaker.
    # No pitch shift (avoids echo artifacts).
    # ══════════════════════════════════════════════════════════════════════════
    else:
        ref_stats    = voice_entry.get("ref_stats", {})
        voice_gender = voice_entry.get("gender", "Male")

        VCTK_F0_TABLE = [
            ("p264", 93.6),
            ("p232", 101.1), ("p228", 102.2), ("p229", 102.7), ("p266", 102.3),
            ("p238", 107.6), ("p234", 111.9), ("p340", 114.5),
            ("p226", 120.8), ("p236", 120.5), ("p233", 126.4),
            ("p239", 136.9),
            ("p362", 169.3), ("p333", 171.1),
            ("p336", 188.7), ("p237", 189.7),
            ("p303", 193.1), ("p294", 197.9),
            ("p250", 209.7), ("p361", 208.8),
            ("p259", 222.2), ("p248", 252.7),
        ]

        ref_f0 = ref_stats.get("f0_mean", 0.0)
        base_speaker = (
            min(VCTK_F0_TABLE, key=lambda x: abs(x[1] - ref_f0))[0]
            if ref_f0 > 60
            else ("p226" if voice_gender == "Male" else "p267")
        )
        base_f0_exp = next((f for s, f in VCTK_F0_TABLE if s == base_speaker), 120.0)

        ref_syl_rate = ref_stats.get("syllable_rate", 0.0)
        tts_speed = (
            max(0.7, min(2.0, (ref_syl_rate / 3.8) * speed))
            if ref_syl_rate > 2.0
            else speed
        )

        sys.stderr.write(
            f"[generate] OpenVoice V2 legacy: VCTK {base_speaker} "
            f"(~{base_f0_exp:.0f} Hz, ref={ref_f0:.0f} Hz), speed={tts_speed:.2f}\n"
        )
        sys.stderr.flush()

        try:
            import torch

            CKPT_DIR = os.path.join(SCRIPT_DIR, "openvoice_model")
            if not os.path.isdir(CKPT_DIR) or \
               not os.path.isfile(os.path.join(CKPT_DIR, "converter", "checkpoint.pth")):
                print(f"OpenVoice V2 model not found at: {CKPT_DIR}\nDownload it from the app first.")
                sys.exit(1)

            ov_src = os.path.join(SCRIPT_DIR, "openvoice_model", "OpenVoice")
            if os.path.isdir(ov_src) and ov_src not in sys.path:
                sys.path.insert(0, ov_src)

            base_path = out_path.replace(".wav", "_base.wav")
            from TTS.api import TTS
            try:
                tts_model = TTS(model_name="tts_models/en/vctk/vits", progress_bar=False, gpu=False)
                tts_model.tts_to_file(text=text, file_path=base_path,
                                      speaker=base_speaker, speed=tts_speed)
            except Exception:
                tts_model = TTS(model_name="tts_models/en/ljspeech/tacotron2-DDC",
                                progress_bar=False, gpu=False)
                tts_model.tts_to_file(text=text, file_path=base_path, speed=tts_speed)

            from openvoice.api import ToneColorConverter
            conv_ckpt = os.path.join(CKPT_DIR, "converter")
            conv = ToneColorConverter(
                os.path.join(conv_ckpt, "config.json"), device="cpu", enable_watermark=False
            )
            conv.load_ckpt(os.path.join(conv_ckpt, "checkpoint.pth"))

            src_se = conv.extract_se([base_path], se_save_path=None)

            if os.path.isfile(emb_pth):
                target_se = torch.load(emb_pth, map_location="cpu", weights_only=True)
            elif os.path.isfile(emb_npy):
                print("This voice was trained with an older encoder (YourTTS).\n"
                      "Please re-train it in the Voice Training panel.")
                sys.exit(1)
            else:
                print(f"No embedding found for voice '{voice_id}' in {voices_dir}")
                sys.exit(1)

            conv.convert(audio_src_path=base_path, src_se=src_se, tgt_se=target_se,
                         output_path=out_path, tau=0.1)

            if os.path.isfile(base_path):
                os.remove(base_path)

            sys.stderr.write(f"[generate] Saved: {out_path}\n")

        except ImportError as ie:
            print(f"Missing dependency: {ie}")
            sys.exit(1)
        except Exception as e:
            import traceback
            print(f"OpenVoice V2 generation error: {e}\n{traceback.format_exc()}")
            sys.exit(1)

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
