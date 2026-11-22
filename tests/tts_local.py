"""Quick local check of the Brazilian Portuguese narration model (no server)."""

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "tts"))
sys.path.insert(0, str(ROOT / "vendor" / "tinyvoca"))
ESPEAK = ROOT / "bin" / "espeak-ng"
os.environ["ESPEAK_DATA_PATH"] = str(ESPEAK)
os.environ["PATH"] = str(ESPEAK) + os.pathsep + os.environ.get("PATH", "")

from tiny_voca_ptbr import Voice  # noqa: E402

MODEL = ROOT / "models" / "tiny-voca" / "tiny-voca-ptbr.onnx"
PHRASES = [
    "Cavalo de g1 para f3.",
    "Peão de e2 para e4.",
    "Roque pequeno.",
    "Xeque.",
]

model = Voice(MODEL, threads=2)
failures = 0
for speaker in ("F", "M"):
    for phrase in PHRASES:
        started = time.perf_counter()
        samples, _ = model.speak(phrase, speaker)
        elapsed = time.perf_counter() - started
        seconds = len(samples) / model.sample_rate
        if seconds < 0.4 or seconds > 20:
            failures += 1
            print(f"FAIL [{speaker}] {phrase!r}: {seconds:.2f}s")
        else:
            print(f"PASS [{speaker}] {seconds:.2f}s audio in {elapsed:.2f}s · {phrase}")

print("sample rate:", model.sample_rate, "voices:", model.voices)
print("ALL TTS TESTS PASSED" if not failures else f"{failures} TTS FAILURE(S)")
raise SystemExit(1 if failures else 0)
