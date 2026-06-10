#!/usr/bin/env python3.11
"""trim.py – Trim a WAV file to a start/end range (seconds)."""
import wave, sys

if len(sys.argv) < 5:
    print("Usage: trim.py <input> <output> <start_sec> <end_sec>", file=sys.stderr)
    sys.exit(1)

input_file  = sys.argv[1]
output_file = sys.argv[2]
start_sec   = float(sys.argv[3])
end_sec     = float(sys.argv[4])

try:
    with wave.open(input_file, 'rb') as wf:
        rate       = wf.getframerate()
        channels   = wf.getnchannels()
        sampwidth  = wf.getsampwidth()
        n_total    = wf.getnframes()
        start_f    = max(0, min(int(start_sec * rate), n_total))
        end_f      = max(0, min(int(end_sec   * rate), n_total))
        if end_f <= start_f:
            print("end_sec must be greater than start_sec", file=sys.stderr)
            sys.exit(1)
        wf.setpos(start_f)
        frames = wf.readframes(end_f - start_f)

    with wave.open(output_file, 'wb') as out:
        out.setnchannels(channels)
        out.setsampwidth(sampwidth)
        out.setframerate(rate)
        out.writeframes(frames)

    print(output_file)
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(1)
