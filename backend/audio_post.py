#!/usr/bin/env python3.11
"""
audio_post.py – Shared audio post-processing for VoiceAI.

These helpers are imported by both generate.py (one-shot subprocess) and
f5_worker.py (persistent model worker) so the post-processing pipeline stays
identical regardless of how a clip was synthesized.
"""

import sys, os
import numpy as np

# Make a bundled FFmpeg (downloaded into backend/bin by setup.ps1) discoverable
# to pydub, which shells out to ffmpeg/ffprobe for non-WAV formats. Prepending
# to PATH in-process propagates to the subprocesses pydub spawns.
_FFMPEG_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin")
if os.path.isdir(_FFMPEG_BIN):
    os.environ["PATH"] = _FFMPEG_BIN + os.pathsep + os.environ.get("PATH", "")
    if hasattr(os, "add_dll_directory"):  # Windows: let native libs find the FFmpeg DLLs
        try:
            _FFMPEG_DLL_DIR = os.add_dll_directory(_FFMPEG_BIN)  # keep ref: GC would un-register it
        except OSError:
            pass


def pitch_shift_wav(path, semitones):
    if abs(semitones) < 0.01:
        return
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
        except Exception:
            pass


def apply_volume(path, vol_pct):
    if abs(vol_pct - 80.0) < 0.5:
        return
    try:
        from pydub import AudioSegment
        a = AudioSegment.from_wav(path)
        (a + 20 * np.log10(max(vol_pct, 1) / 80.0)).export(path, format="wav")
    except Exception:
        pass


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
        sys.stderr.write(f"[post] Mastering preset={preset}\n")
    except Exception as _me:
        sys.stderr.write(f"[post] Mastering skipped: {_me}\n")


def trim_silence_fn(path):
    try:
        from pydub import AudioSegment
        from pydub.silence import detect_leading_silence
        a = AudioSegment.from_wav(path)
        s = detect_leading_silence(a, silence_threshold=-40)
        e = detect_leading_silence(a.reverse(), silence_threshold=-40)
        a[s:len(a) - e].export(path, format="wav")
    except Exception:
        pass


def apply_post(path, pitch_st=0.0, volume_pct=80.0, trim_silence=False, mastering="none"):
    """Run the full post-processing chain in the canonical order."""
    if pitch_st != 0:
        pitch_shift_wav(path, pitch_st)
    if volume_pct != 80:
        apply_volume(path, volume_pct)
    if trim_silence:
        trim_silence_fn(path)
    master_audio(path, mastering)
