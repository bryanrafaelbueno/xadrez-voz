"""Vercel serverless transcription endpoint.

Runs whisper.cpp through pywhispercpp with a quantized base model.
The model is downloaded during the Vercel build into api/models and included
in the function bundle. A /tmp download fallback keeps the endpoint usable if
the includeFiles step is unavailable.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

MODEL_FILE = "ggml-base-q5_1.bin"
MODEL_URL = (
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"
    "ggml-base-q5_1.bin"
)
PROMPTS = {
    "pt": (
        "Comandos de xadrez em português. Casas faladas: a um, a dois, a oito, b um, "
        "c três, d um, d quatro, e dois, e quatro, e cinco, e sete, f um, f três, "
        "g um, g cinco, h cinco. Lances: e2 e4, cavalo de g1 para f3, bispo de f1 para c4, "
        "dama de d1 para h5, torre de a1 para a8, peão de e2 para e4, peão toma d5, "
        "captura em e5, roque pequeno, roque grande, promover a dama, desfazer, nova partida, dica."
    ),
    "en": (
        "Chess commands. Spoken squares: a one, e two, e four, g one, f three, d one, "
        "h five, a one, a eight. Moves: knight from g1 to f3, bishop from f1 to c4, "
        "queen from d1 to h5, rook from a1 to a8, pawn from e2 to e4, pawn takes d5, "
        "capture on e5, castle kingside, castle queenside, promote to queen, undo, new game, hint."
    ),
    "auto": (
        "Chess commands / comandos de xadrez: e2 e4, g1 f3, cavalo de g1 para f3, "
        "castle kingside, roque pequeno, pawn takes d5, peão toma d5, promote to queen, "
        "promover a dama, nova partida, undo, hint."
    ),
}

_MODEL = None
_MODEL_LOCK = threading.Lock()


def _candidate_model_paths() -> list[Path]:
    here = Path(__file__).resolve().parent
    cwd = Path.cwd()
    return [
        here / "models" / MODEL_FILE,
        cwd / "api" / "models" / MODEL_FILE,
        Path("/var/task/api/models") / MODEL_FILE,
        Path("/tmp") / MODEL_FILE,
    ]


def _find_model() -> Path:
    for path in _candidate_model_paths():
        try:
            if path.is_file() and path.stat().st_size > 1_000_000:
                return path
        except OSError:
            continue
    # Fallback for environments where includeFiles did not include the build artifact.
    target = Path("/tmp") / MODEL_FILE
    part = target.with_suffix(target.suffix + ".part")
    print(f"[vercel] model not bundled; downloading {MODEL_URL} to {target}", flush=True)
    with urllib.request.urlopen(MODEL_URL, timeout=180) as response, open(part, "wb") as output:
        shutil.copyfileobj(response, output)
    if part.stat().st_size < 1_000_000:
        raise RuntimeError("Downloaded Whisper model is unexpectedly small.")
    part.replace(target)
    return target


def _load_model():
    global _MODEL
    if _MODEL is None:
        from pywhispercpp.model import Model  # type: ignore

        path = _find_model()
        threads = max(1, int(os.environ.get("WHISPER_THREADS", "2")))
        started = time.time()
        _MODEL = Model(
            str(path),
            n_threads=threads,
            redirect_whispercpp_logs_to=None,
            print_realtime=False,
            print_progress=False,
        )
        print(
            f"[vercel] whisper base loaded from {path} in {time.time() - started:.2f}s",
            flush=True,
        )
    return _MODEL


def _language(raw: str) -> str:
    value = (raw or "auto").lower()
    value = {"pt-br": "pt", "pt_br": "pt", "en-us": "en", "en_us": "en", "en-gb": "en"}.get(value, value)
    return value if value in ("pt", "en") else "auto"


class handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep Vercel logs clean
        return

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        self._json(200, {"ok": True, "service": "xvoz-whisper", "model": MODEL_FILE})

    def do_POST(self):  # noqa: N802
        started = time.time()
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._json(400, {"error": "empty_body"})
            return
        if length > 10 * 1024 * 1024:
            self._json(413, {"error": "too_large"})
            return
        body = self.rfile.read(length)
        if len(body) < 100 or body[:4] != b"RIFF" or body[8:12] != b"WAVE":
            self._json(400, {"error": "invalid_wav", "message": "Envie áudio WAV PCM 16 kHz."})
            return

        query = parse_qs(urlparse(self.path).query)
        lang = _language((query.get("lang") or ["auto"])[0])
        prompt = PROMPTS.get(lang, PROMPTS["auto"])
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as handle:
                handle.write(body)
                temp_path = handle.name
            with _MODEL_LOCK:
                model = _load_model()
                segments = model.transcribe(
                    temp_path,
                    language=lang,
                    initial_prompt=prompt,
                )
            text = " ".join(str(segment.text).strip() for segment in segments if str(segment.text).strip()).strip()
            elapsed = round((time.time() - started) * 1000)
            print(f"[vercel] transcribed {len(body) / 1024:.0f} KiB in {elapsed} ms", flush=True)
            self._json(200, {
                "text": text,
                "language": lang,
                "model": MODEL_FILE,
                "engine": "vercel-whisper",
                "elapsedMs": elapsed,
            })
        except Exception as exc:  # noqa: BLE001
            print("[vercel] transcription failed:\n" + traceback.format_exc(), flush=True)
            self._json(503, {"error": "transcription_failed", "message": str(exc)[:400]})
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
