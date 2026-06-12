#!/usr/bin/env python3
"""
bench_providers.py — Stage-1 de-risking for the ONNX Runtime + DirectML thesis.

Runs the SAME ONNX model under each available execution provider (CUDA, DirectML,
CPU) and reports per-run latency and speedup vs CPU. This isolates one question:
does GPU acceleration via DirectML actually beat CPU on Windows — and by how much?

GO/NO-GO: if DmlExecutionProvider is >= ~3x faster than CPUExecutionProvider on a
non-NVIDIA GPU, the DirectML approach is validated and we proceed to Stage 2.

Usage (on a Windows machine; DirectML is Windows-only):
    pip install onnxruntime-directml numpy
    python bench_providers.py --model C:\\path\\to\\kokoro-v1.0.onnx

Notes:
  * Inputs are synthesised from the model's signature, so this measures pure
    inference throughput per provider — exactly the variable we care about for
    the GO/NO-GO ratio. True audio RTF comes in Stage 2 with the real engine.
  * Use any ONNX model you already have; the app's Kokoro model is a fine subject.
"""
import argparse
import sys
import time

import numpy as np

try:
    import onnxruntime as ort
except ImportError:
    sys.exit("onnxruntime not installed. Run: pip install onnxruntime-directml numpy")

# (provider id, human label) — ordered fastest-expected first.
PROVIDERS = [
    ("CUDAExecutionProvider", "NVIDIA CUDA"),
    ("DmlExecutionProvider",  "DirectML (any GPU)"),
    ("CPUExecutionProvider",  "CPU"),
]


def _dtype_for(type_str):
    if "int64" in type_str:
        return np.int64
    if "int32" in type_str:
        return np.int32
    if "float16" in type_str:
        return np.float16
    return np.float32


def synth_inputs(sess, seq_len):
    """Build correctly-typed random inputs from the model signature.

    Dynamic dimensions (None / strings / -1) are filled: the first dim with 1
    (batch), any other dynamic dim with `seq_len`. Integer inputs (token ids)
    get small non-negative values; float inputs get standard-normal noise.
    """
    feed = {}
    for inp in sess.get_inputs():
        shape = []
        for idx, d in enumerate(inp.shape):
            if isinstance(d, int) and d > 0:
                shape.append(d)
            else:
                shape.append(1 if idx == 0 else seq_len)
        dt = _dtype_for(inp.type)
        if dt in (np.int64, np.int32):
            feed[inp.name] = np.random.randint(0, 50, size=shape).astype(dt)
        else:
            feed[inp.name] = np.random.randn(*shape).astype(dt)
    return feed


def bench(model_path, provider, runs, seq_len):
    """Return mean seconds/run for `provider`, or None if it didn't activate."""
    sess = ort.InferenceSession(model_path, providers=[provider])
    active = sess.get_providers()[0]
    if active != provider:
        return None  # ORT silently fell back to another provider
    feed = synth_inputs(sess, seq_len)
    sess.run(None, feed)  # warmup: triggers kernel compile / graph optimisation
    t0 = time.perf_counter()
    for _ in range(runs):
        sess.run(None, feed)
    return (time.perf_counter() - t0) / runs


def main():
    ap = argparse.ArgumentParser(description="Benchmark an ONNX model across execution providers.")
    ap.add_argument("--model", required=True, help="Path to the .onnx model")
    ap.add_argument("--runs", type=int, default=20, help="Timed runs per provider (default 20)")
    ap.add_argument("--seq", type=int, default=128, help="Length for dynamic dims (default 128)")
    args = ap.parse_args()

    print(f"onnxruntime {ort.__version__}")
    print(f"available providers: {ort.get_available_providers()}")
    print(f"model: {args.model}\n")

    results = {}
    for prov, label in PROVIDERS:
        if prov not in ort.get_available_providers():
            print(f"  {label:24s}  — not available in this onnxruntime build")
            continue
        try:
            dt = bench(args.model, prov, args.runs, args.seq)
            if dt is None:
                print(f"  {label:24s}  — could not activate (ORT fell back)")
                continue
            results[label] = dt
            print(f"  {label:24s}  {dt * 1000:8.1f} ms/run")
        except Exception as e:
            print(f"  {label:24s}  failed: {str(e)[:70]}")

    if "CPU" in results and len(results) > 1:
        cpu = results["CPU"]
        print("\nspeedup vs CPU:")
        for label, dt in results.items():
            if label != "CPU":
                print(f"  {label:24s}  {cpu / dt:5.1f}x")
        print("\nGO/NO-GO:  DirectML >= ~3x CPU  =>  thesis validated, proceed to Stage 2.")
    elif "CPU" not in results:
        print("\nCPU provider didn't run — cannot compute speedup ratio.")
    else:
        print("\nOnly CPU ran — no GPU provider available on this machine.")


if __name__ == "__main__":
    main()
