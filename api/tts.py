"""Vercel placeholder for the local neural TTS endpoint.

The Vercel deployment uses the browser's speech synthesis for narration.
This endpoint keeps the API surface explicit for clients that probe it.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def do_GET(self):  # noqa: N802
        self._respond()

    def do_POST(self):  # noqa: N802
        self._respond()

    def _respond(self):
        payload = {
            "error": "tts_unavailable",
            "message": "A narração neural local não está disponível na Vercel. O app usa a voz pt-BR do navegador.",
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(503)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
