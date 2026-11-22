"""Vercel health endpoint for the serverless Whisper base deployment."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def do_GET(self):  # noqa: N802
        payload = {
            "ok": True,
            "state": "ready",
            "engine": "vercel",
            "whisperAvailable": True,
            "model": "ggml-base-q5_1.bin",
            "defaultModel": "base",
            "modelVariant": "q5_1",
            "models": [
                {
                    "id": "base",
                    "variant": "q5_1",
                    "file": "ggml-base-q5_1.bin",
                    "label": "Base · q5_1",
                    "sizeMb": 57,
                }
            ],
            "threads": 2,
            "lastError": "",
            "tts": {
                "available": False,
                "state": "unavailable",
                "engine": "browser",
                "model": None,
                "voices": [],
                "sampleRate": 0,
                "error": "Narração neural local não roda na Vercel; usando a voz do navegador.",
            },
            "ttsAvailable": False,
            "version": "XadrezVoz Vercel",
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
