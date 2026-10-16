# AGENTS.md — Codex / AI coding agent instructions

**Mandatory source of truth:** read [`DEVELOPMENT_SPEC.md`](./DEVELOPMENT_SPEC.md) completely before modifying code. This project is a Korean-language, offline-first, non-destructive **broadcast news media restoration tool** (audio cleanup, masked exposure, low-light noise reduction, mixed-light white balance, and basic video cuts).

## Absolute policy: NO GENERATION

Never implement or enable generative audio/video/image features: no TTS, voice cloning, hallucinated missing words, diffusion, inpainting, fake details, face synthesis, frame interpolation, synthetic backgrounds, or new sounds. No reconstruction of content that was never recorded. Only source-conditioned conservative signal processing and AI segmentation/tracking to select existing source regions are allowed. All restoration effects default OFF, original files are immutable, and offline processing is the default. There is no exception for quality improvements.

## Coding behavior

1. Inspect the current repository, Git status, language/toolchain, tests, FFmpeg/ffprobe availability, and installed GPU hardware before implementing. Do not overwrite user changes.
2. If an actual Shotcut/MLT project exists, extend it without creating a competing editor. If the repo is empty, first build a standalone Python 3.11+ / PySide6 + FFmpeg/OpenCV/NumPy/SciPy application with a GUI-independent `engine` and CLI. Do not start by cloning all of Shotcut.
3. Implement the first incomplete milestone in `DEVELOPMENT_SPEC.md` (M0 → M1 audio → M2 manually masked exposure → M3 video noise/WB → M4 edit/export → M5 packaging). Deliver working behavior, not mock UI.
4. Add tests and run them. Document command/output and limitations in `docs/TEST_REPORT.md`; update `docs/PROGRESS.md` and architectural decisions in `docs/DECISIONS.md`.
5. Use local media only. No uploads, telemetry, AI APIs, embedded credentials, destructive edits, or silent transcoding. Preserve A/V sync, frame order, metadata and timecode where supported; detect and report unsupported formats.
6. Treat dependencies and model weights as untrusted until compatibility, license and non-generative behavior are verified. DeepFilterNet/FastDVDnet are research candidates **not approved for default production use**.
7. Before describing a feature as complete, verify that real media flows through the real engine; ensure source SHA-256 is unchanged and that all tests pass or failures are reported.
8. Continue with implementation rather than responding with abstract plans only. If an external dependency is unavailable, implement the safest usable subset with a stub clearly marked unsupported rather than a fake working result.

## Required output at session end

Report: requirements/milestones completed, files changed, exact commands run, tests passed/failed/not run, source-integrity and no-generation checks, remaining blockers, and the next concrete task.
