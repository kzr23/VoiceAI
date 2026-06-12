# windows-poc — ONNX Runtime + DirectML voice engine (Windows)

A self-contained proof-of-concept that re-implements **only the generation
engine** on **ONNX Runtime + DirectML**, so voice cloning runs GPU-accelerated
on *any* Windows GPU (NVIDIA, AMD, Intel) — not just NVIDIA/CUDA like the main
PyTorch app.

> Nothing in this folder touches the shipping app. `frontend/`, `backend/`,
> `scripts/`, and `.github/workflows/release.yml` are untouched. Everything new
> lives here.

## Why
The main app uses PyTorch, whose only GPU path on Windows is **CUDA (NVIDIA
only)** — so AMD/Intel Windows users fall back to slow CPU. ONNX Runtime's
**DirectML** execution provider runs on any DX12 GPU, which is the single
biggest lever for fast custom-voice generation on Windows.

"What ElevenLabs uses" is not an option here — that's a closed cloud service on
datacenter NVIDIA GPUs. The local equivalent of their *approach* (best model +
GPU acceleration + streaming) is exactly ONNX Runtime + DirectML.

## Staged plan (de-risk before building)

| Stage | Goal | Status |
|-------|------|--------|
| **1** | Prove DirectML is meaningfully faster than CPU on a real ONNX model | ← you are here |
| 2 | Wire a persistent ONNX generation engine (model loaded once) | not started |
| 3 | Copy the existing frontend + browse-voices UI, point generate at the engine | not started |
| 4 | Windows-only installer via a separate `poc-v*` CI workflow | not started |

**Do not build past Stage 1 until the GO/NO-GO gate passes.**

## Stage 1 — run the provider benchmark (on a Windows machine)

DirectML is Windows-only, so this must run on Windows (a VM is fine).

```powershell
cd windows-poc\engine
python -m venv venv
venv\Scripts\pip install -r requirements.txt

# Use any ONNX model you already have — e.g. the app's Kokoro model:
venv\Scripts\python bench_providers.py --model C:\path\to\kokoro-v1.0.onnx
```

It runs the same model under each available execution provider and prints
latency + speedup vs CPU.

### GO / NO-GO gate
- **DirectML ≥ ~3× CPU** on a non-NVIDIA GPU → thesis validated, proceed to Stage 2.
- **DirectML ≈ CPU** → stop. ONNX/DirectML isn't worth it; stay on PyTorch+CUDA
  and just guide non-NVIDIA users to built-in voices.
