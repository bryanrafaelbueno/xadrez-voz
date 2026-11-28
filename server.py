#!/usr/bin/env python3
"""
Xadrez Voz — local web server.

Serves the static app, transcribes microphone audio with a local whisper.cpp
model (quantized, CPU) and narrates in Brazilian Portuguese with a local neural
voice (tiny-voca). All processing stays on the machine.

Usage:
    python server.py [--port 8765] [--model small] [--cli] [--no-browser]
"""

from __future__ import annotations

import argparse
import atexit
import io
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
import webbrowser
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# O console do Windows pode estar em cp1252; os banners usam caracteres Unicode.
if os.name == "nt":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Quando empacotado com PyInstaller, os dados (models, bin, vendor, assets)
# ficam ao lado do .exe, não dentro da pasta temporária _MEIPASS.
if getattr(sys, "frozen", False):
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent
WHISPER_DIR = ROOT / "bin" / "whisper"
MODELS_DIR = ROOT / "models"
LOG_FILE = ROOT / "whisper-server.log"
TTS_DIR = ROOT / "vendor" / "tinyvoca"
TTS_VENDOR_DIR = ROOT / "vendor" / "tts"
TTS_MODEL = ROOT / "models" / "tiny-voca" / "tiny-voca-ptbr.onnx"
ESPEAK_DIR = ROOT / "bin" / "espeak-ng"

IS_WINDOWS = os.name == "nt"
EXE_SERVER = WHISPER_DIR / ("whisper-server.exe" if IS_WINDOWS else "whisper-server")
EXE_CLI = WHISPER_DIR / ("whisper-cli.exe" if IS_WINDOWS else "whisper-cli")

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

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".wav": "audio/wav",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json",
}


def log(message: str) -> None:
    stamp = time.strftime("%H:%M:%S")
    print(f"[{stamp}] {message}", flush=True)


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def port_open(port: int, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def parse_model_stem(stem: str) -> tuple[str, str]:
    """ggml-small-q5_1 -> ('small', 'q5_1')."""
    name = stem
    if name.startswith("ggml-"):
        name = name[5:]
    variant = ""
    match = re.search(r"-(q[0-9]_[0-9]|q[0-9]|f16)$", name)
    if match:
        variant = match.group(1)
        name = name[: match.start()]
    return name, variant


def discover_models() -> list[dict]:
    models: list[dict] = []
    if not MODELS_DIR.is_dir():
        return models
    for path in sorted(MODELS_DIR.glob("ggml-*.bin")):
        name, variant = parse_model_stem(path.stem)
        models.append(
            {
                "id": name,
                "variant": variant,
                "file": path.name,
                "label": name.capitalize() + (f" · {variant}" if variant else ""),
                "sizeMb": round(path.stat().st_size / (1024 * 1024), 1),
                "path": path,
            }
        )
    # Prefer q5_1 variants, then q8_0/q5_0, then others.
    preference = {"q5_1": 0, "q5_0": 1, "q8_0": 2, "q4_1": 3, "q4_0": 4, "": 5, "f16": 6}

    def sort_key(model: dict):
        size_bonus = {"small": 0, "base": 1, "medium": 2, "tiny": 3, "large": 4}
        return (size_bonus.get(model["id"], 9), preference.get(model["variant"], 9))

    models.sort(key=sort_key)
    return models


class WhisperManager:
    def __init__(self, preferred_model: str | None, threads: int, use_cli: bool = False):
        self.models = discover_models()
        self.threads = threads
        self.use_cli = use_cli
        self.lock = threading.Lock()
        self.process: subprocess.Popen | None = None
        self.port: int | None = None
        self.model: dict | None = None
        self.state = "starting"
        self.last_error = ""
        self._log_handle = None
        self.default_model = self._resolve(None, preferred_model)
        if not self.models:
            self.state = "missing_models"
            self.last_error = "Nenhum modelo ggml-*.bin encontrado em models/."
        elif not EXE_CLI.exists() and not EXE_SERVER.exists():
            self.state = "missing_binary"
            self.last_error = "whisper.cpp não encontrado em bin/whisper/."
        elif self.use_cli or not EXE_SERVER.exists():
            self.state = "ready"
            self.use_cli = True

    def _resolve(self, name: str | None, preferred: str | None = None) -> dict | None:
        if not self.models:
            return None
        query = (name or preferred or "").strip().lower()
        if query:
            for model in self.models:
                if query in (model["id"].lower(), model["file"].lower(), model["file"].lower().removesuffix(".bin")):
                    return model
            for model in self.models:
                if model["id"].lower() == query:
                    return model
        for preferred_name in ("base", "small", "tiny", "medium"):
            for model in self.models:
                if model["id"].lower() == preferred_name:
                    return model
        return self.models[0]

    def _open_log(self):
        try:
            return open(LOG_FILE, "a", encoding="utf-8", errors="replace")
        except OSError:
            return subprocess.DEVNULL

    def _start_server(self, model: dict) -> bool:
        if not EXE_SERVER.exists():
            return False
        self._stop_server()
        port = find_free_port()
        cmd = [
            str(EXE_SERVER),
            "-m", str(model["path"]),
            "-t", str(self.threads),
            "-bs", "5",
            "-bo", "5",
            "-nt",
            "--host", "127.0.0.1",
            "--port", str(port),
        ]
        creationflags = 0
        if IS_WINDOWS:
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            self._log_handle = self._open_log()
            self.process = subprocess.Popen(
                cmd,
                cwd=str(WHISPER_DIR),
                stdout=self._log_handle,
                stderr=self._log_handle,
                stdin=subprocess.DEVNULL,
                creationflags=creationflags,
            )
        except Exception as exc:  # noqa: BLE001
            self.last_error = f"Falha ao iniciar whisper-server: {exc}"
            self.process = None
            return False
        self.port = port
        self.model = model
        deadline = time.time() + 45
        while time.time() < deadline:
            if self.process.poll() is not None:
                self.last_error = f"whisper-server encerrou (código {self.process.returncode}). Veja whisper-server.log."
                self._stop_server()
                return False
            if port_open(port):
                log(f"Whisper pronto: modelo {model['file']} (porta {port}, {self.threads} threads)")
                return True
            time.sleep(0.25)
        self.last_error = "Tempo esgotado ao carregar o modelo Whisper."
        self._stop_server()
        return False

    def _stop_server(self):
        proc = self.process
        self.process = None
        self.port = None
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
        if self._log_handle not in (None, subprocess.DEVNULL):
            try:
                self._log_handle.close()
            except Exception:  # noqa: BLE001
                pass
        self._log_handle = None

    def start(self):
        if self.state in ("missing_models", "missing_binary"):
            return
        if self.use_cli:
            self.state = "ready"
            log(f"Modo CLI do Whisper ativo (modelo padrão: {self.default_model['file'] if self.default_model else '?'})")
            return
        model = self.default_model
        if model is None:
            self.state = "missing_models"
            return
        self.state = "loading"
        threading.Thread(target=self._load_default, daemon=True).start()

    def _load_default(self):
        with self.lock:
            ok = self._start_server(self.default_model)
            self.state = "ready" if ok else "fallback_cli"
            if not ok:
                self.use_cli = True
                log(f"Servidor Whisper indisponível ({self.last_error}); usando CLI por requisição.")

    def ensure_model(self, requested: str | None) -> dict | None:
        model = self._resolve(requested)
        if model is None:
            return None
        if self.use_cli:
            return model
        if self.process is None or self.model is None or self.model["path"] != model["path"]:
            self.state = "loading"
            ok = self._start_server(model)
            self.state = "ready" if ok else "fallback_cli"
            if not ok:
                self.use_cli = True
                log(f"Falha no whisper-server ({self.last_error}); alternando para CLI.")
        return model

    def transcribe(self, wav_bytes: bytes, lang: str, requested_model: str | None) -> dict:
        if self.state in ("missing_models", "missing_binary"):
            raise RuntimeError(self.last_error or "Whisper não está instalado.")
        lang = (lang or "auto").lower()
        lang = {"pt-br": "pt", "pt-pt": "pt", "en-us": "en", "en-gb": "en"}.get(lang, lang)
        if lang not in ("pt", "en", "auto"):
            lang = "auto"
        prompt = PROMPTS.get(lang, PROMPTS["auto"])
        with self.lock:
            model = self.ensure_model(requested_model)
            if model is None:
                raise RuntimeError("Modelo Whisper não encontrado.")
            started = time.time()
            text = ""
            engine = "cli"
            if not self.use_cli and self.process is not None and self.port:
                try:
                    text = self._post_server(wav_bytes, lang, prompt, self.port)
                    engine = "server"
                except Exception as exc:  # noqa: BLE001
                    log(f"Falha na inferência via servidor: {exc}; tentando CLI.")
                    self.use_cli = True
            if not text:
                text = self._run_cli(wav_bytes, lang, prompt, model)
                engine = "cli"
            return {
                "text": text.strip(),
                "language": lang,
                "model": model["file"],
                "engine": engine,
                "elapsedMs": round((time.time() - started) * 1000),
            }

    def _post_server(self, wav_bytes: bytes, lang: str, prompt: str, port: int) -> str:
        boundary = "----ChessVoice" + secrets.token_hex(10)
        chunks: list[bytes] = []

        def field(name: str, value: str):
            chunks.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8")
            )

        chunks.append(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
                "Content-Type: audio/wav\r\n\r\n"
            ).encode("utf-8")
        )
        chunks.append(wav_bytes)
        chunks.append(b"\r\n")
        field("response_format", "json")
        field("temperature", "0.0")
        field("language", lang)
        field("prompt", prompt)
        chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
        body = b"".join(chunks)
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/inference",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = resp.read().decode("utf-8", errors="replace")
        data = json.loads(payload)
        text = data.get("text")
        if isinstance(text, list):
            text = " ".join(str(part) for part in text)
        return str(text or "")

    def _run_cli(self, wav_bytes: bytes, lang: str, prompt: str, model: dict) -> str:
        if not EXE_CLI.exists():
            raise RuntimeError("whisper-cli não encontrado.")
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as handle:
                handle.write(wav_bytes)
                temp_path = handle.name
            cmd = [
                str(EXE_CLI),
                "-m", str(model["path"]),
                "-f", temp_path,
                "-l", lang,
                "-t", str(self.threads),
                "-bs", "5",
                "-bo", "5",
                "-nt",
                "-np",
                "--prompt", prompt,
            ]
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if IS_WINDOWS else 0
            result = subprocess.run(
                cmd,
                cwd=str(WHISPER_DIR),
                capture_output=True,
                text=True,
                timeout=180,
                creationflags=creationflags,
            )
            if result.returncode != 0:
                raise RuntimeError((result.stderr or "whisper-cli failed").strip()[-400:])
            lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
            return " ".join(lines).strip()
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

    def status(self) -> dict:
        return {
            "state": self.state,
            "engine": "cli" if self.use_cli else ("server" if self.process else "starting"),
            "model": self.model["file"] if self.model else (self.default_model["file"] if self.default_model else None),
            "defaultModel": self.default_model["id"] if self.default_model else None,
            "modelVariant": self.model["variant"] if self.model else (self.default_model["variant"] if self.default_model else None),
            "models": [
                {k: v for k, v in model.items() if k != "path"} for model in self.models
            ],
            "threads": self.threads,
            "lastError": self.last_error,
        }

    def shutdown(self):
        self._stop_server()


class TtsManager:
    """Brazilian Portuguese neural TTS (tiny-voca, 21 MB) loaded in-process."""

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.state = "unavailable"
        self.error = ""
        self.model = None
        self.sample_rate = 24000
        self.lock = threading.Lock()
        self.load_lock = threading.Lock()
        self.ready_event = threading.Event()
        self.cache: OrderedDict[tuple[str, str], tuple[bytes, int, int]] = OrderedDict()
        self.cache_limit = 48
        if not enabled:
            self.error = "Narração local desativada (--no-tts)."
            self.ready_event.set()
            return
        missing = []
        if not TTS_MODEL.is_file():
            missing.append("modelo pt-BR")
        if not (TTS_MODEL.with_suffix(".json")).is_file():
            missing.append("configuração do modelo")
        if not (TTS_DIR / "tiny_voca_ptbr").is_dir():
            missing.append("pacote tiny-voca")
        if not TTS_VENDOR_DIR.is_dir():
            missing.append("runtime onnxruntime/numpy")
        espeak_exe = ESPEAK_DIR / ("espeak-ng.exe" if IS_WINDOWS else "espeak-ng")
        if not espeak_exe.is_file() and shutil.which("espeak-ng") is None:
            missing.append("eSpeak NG")
        if missing:
            self.error = "Faltando: " + ", ".join(missing)
            self.state = "unavailable"
            self.ready_event.set()
            return
        self.state = "loading"

    def start(self):
        if self.state != "loading":
            return
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        with self.load_lock:
            if self.state == "ready":
                return
            try:
                if str(TTS_VENDOR_DIR) not in sys.path:
                    sys.path.insert(0, str(TTS_VENDOR_DIR))
                if str(TTS_DIR) not in sys.path:
                    sys.path.insert(0, str(TTS_DIR))
                espeak_exe = ESPEAK_DIR / ("espeak-ng.exe" if IS_WINDOWS else "espeak-ng")
                if espeak_exe.is_file():
                    os.environ["ESPEAK_DATA_PATH"] = str(ESPEAK_DIR)
                    os.environ["PATH"] = str(ESPEAK_DIR) + os.pathsep + os.environ.get("PATH", "")
                from tiny_voca_ptbr import Voice  # type: ignore

                self.model = Voice(TTS_MODEL, threads=2)
                self.sample_rate = int(self.model.sample_rate)
                self.state = "ready"
                self.error = ""
                log(f"Voz pt-BR pronta: tiny-voca ({self.sample_rate} Hz, vozes F/M)")
            except Exception as exc:  # noqa: BLE001
                self.state = "unavailable"
                self.error = str(exc)[:400]
                log(f"Voz pt-BR indisponível: {self.error}")
            finally:
                self.ready_event.set()

    def ensure(self, timeout: float = 60.0) -> bool:
        if self.state == "ready":
            return True
        if self.state == "unavailable":
            return False
        self.ready_event.wait(timeout)
        return self.state == "ready"

    def synthesize(self, text: str, speaker: str = "F") -> tuple[bytes, int, int]:
        text = " ".join(str(text or "").split()).strip()
        if not text:
            raise ValueError("Texto vazio.")
        if len(text) > 600:
            raise ValueError("Texto muito longo.")
        speaker = "M" if str(speaker).upper() == "M" else "F"
        key = (text, speaker)
        with self.lock:
            cached = self.cache.get(key)
            if cached is not None:
                self.cache.move_to_end(key)
                return cached[0], cached[1], cached[2]

        if not self.ensure():
            raise RuntimeError(self.error or "Voz pt-BR indisponível.")
        if self.model is None:
            raise RuntimeError("Voz pt-BR não carregada.")

        import numpy as np  # type: ignore

        with self.lock:
            samples, _ = self.model.speak(text, speaker)
            samples = np.asarray(samples, dtype=np.float32)
            fade = min(len(samples), int(self.sample_rate * 0.006))
            if fade > 1:
                ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
                samples[:fade] *= ramp
                samples[-fade:] *= ramp[::-1]
            pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(self.sample_rate)
                handle.writeframes(pcm.tobytes())
            data = buffer.getvalue()
            duration_ms = round((len(samples) / self.sample_rate) * 1000)
            self.cache[key] = (data, duration_ms, self.sample_rate)
            self.cache.move_to_end(key)
            while len(self.cache) > self.cache_limit:
                self.cache.popitem(last=False)
            return data, duration_ms, self.sample_rate

    def status(self) -> dict:
        return {
            "available": self.state == "ready",
            "state": self.state,
            "engine": "tiny-voca",
            "model": "tiny-voca-ptbr",
            "voices": ["F", "M"],
            "sampleRate": self.sample_rate,
            "error": self.error,
        }


class AppServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True


class AppHandler(BaseHTTPRequestHandler):
    manager: WhisperManager
    tts: TtsManager
    verbose = False

    server_version = "XadrezVoz/1.0"

    def log_message(self, fmt, *args):  # noqa: A003
        if self.verbose:
            super().log_message(fmt, *args)

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            status = self.manager.status()
            status["ok"] = status["state"] not in ("missing_models", "missing_binary")
            status["whisperAvailable"] = status["ok"]
            status["version"] = self.server_version
            tts = self.tts.status()
            status["tts"] = tts
            status["ttsAvailable"] = tts["available"]
            self.send_json(200, status)
            return
        if parsed.path == "/api/models":
            self.send_json(200, {"default": self.manager.status()["defaultModel"], "models": self.manager.status()["models"]})
            return
        self.serve_static(parsed.path)

    def serve_static(self, url_path: str):
        if url_path in ("", "/"):
            url_path = "/index.html"
        relative = urllib.parse.unquote(url_path.lstrip("/"))
        target = (ROOT / relative).resolve()
        try:
            target.relative_to(ROOT)
        except ValueError:
            self.send_error(403, "Forbidden")
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self.send_error(404, "Not found")
            return
        suffix = target.suffix.lower()
        mime = MIME_TYPES.get(suffix, "application/octet-stream")
        try:
            data = target.read_bytes()
        except OSError:
            self.send_error(500, "Could not read file")
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        if suffix in (".html", ".js", ".mjs", ".css", ".json"):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/tts":
            self.handle_tts()
            return
        if parsed.path != "/api/transcribe":
            self.send_json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self.send_json(400, {"error": "empty_body"})
            return
        if length > 25 * 1024 * 1024:
            self.send_json(413, {"error": "too_large"})
            return
        body = self.rfile.read(length)
        if len(body) < 100 or body[:4] != b"RIFF" or body[8:12] != b"WAVE":
            self.send_json(400, {"error": "invalid_wav", "message": "Envie áudio WAV PCM."})
            return
        query = urllib.parse.parse_qs(parsed.query)
        lang = (query.get("lang", ["auto"])[0] or "auto").lower()
        model = query.get("model", [None])[0]
        try:
            result = self.manager.transcribe(body, lang, model)
            self.send_json(200, result)
        except Exception as exc:  # noqa: BLE001
            log(f"Erro na transcrição: {exc}")
            self.send_json(503, {"error": "transcription_failed", "message": str(exc)})

    def handle_tts(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self.send_json(400, {"error": "empty_body"})
            return
        if length > 20000:
            self.send_json(413, {"error": "too_large"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.send_json(400, {"error": "invalid_json"})
            return
        text = str(payload.get("text") or "")
        lang = str(payload.get("lang") or "pt").lower()
        voice = str(payload.get("voice") or "F").upper()
        if lang not in ("pt", "pt-br", "pt_br", "auto"):
            self.send_json(400, {"error": "unsupported_language", "message": "A voz local fala português do Brasil."})
            return
        if not text.strip():
            self.send_json(400, {"error": "empty_text"})
            return
        try:
            wav_bytes, duration_ms, sample_rate = self.tts.synthesize(text, voice)
        except Exception as exc:  # noqa: BLE001
            log(f"Erro na voz: {exc}")
            self.send_json(503, {"error": "tts_failed", "message": str(exc)})
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav_bytes)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-TTS-Voice", voice)
        self.send_header("X-TTS-Duration-Ms", str(duration_ms))
        self.send_header("X-TTS-Sample-Rate", str(sample_rate))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(wav_bytes)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Xadrez Voz local server")
    parser.add_argument("--port", type=int, default=8765, help="HTTP port (default 8765)")
    parser.add_argument("--model", default=None, help="Whisper model id, e.g. small or base")
    parser.add_argument("--threads", type=int, default=max(2, min(6, os.cpu_count() or 4)))
    parser.add_argument("--cli", action="store_true", help="Use whisper-cli per request (no resident server)")
    parser.add_argument("--no-tts", action="store_true", help="Disable the local pt-BR narration voice")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    manager = WhisperManager(args.model, args.threads, use_cli=args.cli)
    manager.start()
    tts = TtsManager(enabled=not args.no_tts)
    tts.start()
    atexit.register(manager.shutdown)

    handler = type("BoundHandler", (AppHandler,), {"manager": manager, "tts": tts, "verbose": args.verbose})
    port = args.port
    httpd = None
    for attempt in range(50):
        if port_open(port):
            port += 1
            continue
        try:
            httpd = AppServer(("127.0.0.1", port), handler)
            log(f"Porta HTTP {port} aberta")
            break
        except OSError:
            port += 1
    if httpd is None:
        log("Não foi possível abrir uma porta HTTP.")
        return 1

    url = f"http://127.0.0.1:{port}/"
    print()
    print("  ♞  XADREZ VOZ")
    print("  --------------------------------------------------")
    print(f"  App:      {url}")
    print(f"  Modelo:   {(manager.default_model or {}).get('file', 'indisponível')}")
    print(f"  Whisper:  {manager.status()['state']} ({manager.status()['engine']})")
    print(f"  Voz:      {tts.status()['state']} (pt-BR, tiny-voca)")
    print(f"  Threads:  {args.threads}")
    print("  Ctrl+C encerra o servidor.")
    print()

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrando…")
    finally:
        httpd.server_close()
        manager.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
