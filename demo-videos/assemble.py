#!/usr/bin/env python3
"""Monta os vídeos de demonstração do path tracing a partir dos frames do CDP."""

from __future__ import annotations

import bisect
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
FRAMES_ROOT = ROOT / "frames"
VIDEO_ROOT = ROOT / "videos"
POSTER_ROOT = ROOT / "posters"
WIDTH = 1920
HEIGHT = 1080
FPS = 30
FADE_IN = 0.35
FADE_OUT = 0.55

FFMPEG_CANDIDATES = [
    Path(r"C:\Users\Bryan Rafael\AppData\Local\hermes\tools\ffmpeg-9.0.1-win32-x64\bin\ffmpeg.exe"),
    Path("ffmpeg.exe"),
]


def find_ffmpeg() -> str:
    for candidate in FFMPEG_CANDIDATES:
        if candidate.is_file():
            return str(candidate)
    found = shutil.which("ffmpeg")
    if found:
        return found
    raise SystemExit("ffmpeg não encontrado.")


def load_scenario(folder: Path) -> dict:
    meta_path = folder / "meta.json"
    if not meta_path.is_file():
        raise SystemExit(f"meta.json ausente em {folder}")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    frames = sorted(meta["frames"], key=lambda item: item["t"])
    if not frames:
        raise SystemExit(f"sem frames em {folder}")

    times: list[float] = []
    paths: list[Path] = []
    last_time = -1.0
    for frame in frames:
        t = max(0.0, float(frame["t"]))
        if t < last_time:
            t = last_time
        times.append(t)
        paths.append(folder / frame["file"])
        last_time = t

    duration = float(meta.get("endRel") or (times[-1] + 1.0))
    duration = max(duration, times[-1] + 0.2)

    return {
        "id": meta["scenario"]["id"],
        "title": meta["scenario"]["title"],
        "meta": meta,
        "times": times,
        "paths": paths,
        "duration": duration,
    }


def pick_frame(times: list[float], t: float) -> int:
    index = bisect.bisect_right(times, t + 1e-6) - 1
    if index < 0:
        return 0
    return min(index, len(times) - 1)


def render_video(scenario: dict, ffmpeg: str) -> Path:
    out_path = VIDEO_ROOT / f"{scenario['id']}.mp4"
    duration = scenario["duration"]
    total_frames = max(1, int(math.ceil(duration * FPS)))
    fade_frames = max(1, int(FADE_OUT * FPS))
    fade_in_frames = max(1, int(FADE_IN * FPS))

    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-s",
        f"{WIDTH}x{HEIGHT}",
        "-r",
        str(FPS),
        "-i",
        "-",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "17",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-metadata",
        f"title={scenario['title']} — path tracing",
        "-metadata",
        "comment=Xadrez Voz + Mesa XY · demonstração de path tracing",
        str(out_path),
    ]

    print(f"\n== {scenario['id']} ==")
    print(f"duração {duration:.2f}s · {total_frames} frames @ {FPS}fps · {WIDTH}x{HEIGHT}")

    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    if process.stdin is None:
        raise SystemExit("não foi possível abrir o pipe do ffmpeg")

    poster_index = max(1, int(total_frames * 0.42))
    poster_saved = False
    cache: dict[int, np.ndarray] = {}

    try:
        for index in range(total_frames):
            t = index / FPS
            source_index = pick_frame(scenario["times"], t)
            frame = cache.get(source_index)
            if frame is None:
                frame = cv2.imread(str(scenario["paths"][source_index]), cv2.IMREAD_COLOR)
                if frame is None:
                    raise SystemExit(f"frame ilegível: {scenario['paths'][source_index]}")
                if frame.shape[1] != WIDTH or frame.shape[0] != HEIGHT:
                    frame = cv2.resize(frame, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA)
                if len(cache) > 4:
                    cache.clear()
                cache[source_index] = frame

            output = frame

            if index < fade_in_frames:
                factor = index / fade_in_frames
                output = (output.astype(np.float32) * factor).astype(np.uint8)
            elif index >= total_frames - fade_frames:
                remaining = (total_frames - 1 - index) / fade_frames
                factor = max(0.0, min(1.0, remaining))
                output = (output.astype(np.float32) * factor).astype(np.uint8)

            process.stdin.write(output.tobytes())

            if not poster_saved and index >= poster_index:
                cv2.imwrite(
                    str(POSTER_ROOT / f"{scenario['id']}.jpg"),
                    frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 92],
                )
                poster_saved = True

            if index % 90 == 0:
                print(f"  {index}/{total_frames}", flush=True)
    finally:
        process.stdin.close()
        process.wait()

    if process.returncode != 0:
        raise SystemExit(f"ffmpeg falhou com código {process.returncode}")

    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"  -> {out_path} ({size_mb:.1f} MB)")
    return out_path


def main() -> int:
    only = None
    clean = "--clean" in sys.argv
    for arg in sys.argv[1:]:
        if arg.startswith("--only="):
            only = arg.split("=", 1)[1]

    VIDEO_ROOT.mkdir(parents=True, exist_ok=True)
    POSTER_ROOT.mkdir(parents=True, exist_ok=True)

    folders = sorted(
        folder for folder in FRAMES_ROOT.iterdir() if folder.is_dir() and (folder / "meta.json").is_file()
    )
    if not folders:
        raise SystemExit("nenhuma gravação encontrada em demo-videos/frames")

    ffmpeg = find_ffmpeg()
    print(f"ffmpeg: {ffmpeg}")

    outputs = []
    for folder in folders:
        scenario = load_scenario(folder)
        if only and only not in scenario["id"]:
            continue
        outputs.append(render_video(scenario, ffmpeg))

    print("\nVídeos gerados:")
    for output in outputs:
        print(f"  {output}")

    if clean and not only:
        shutil.rmtree(FRAMES_ROOT, ignore_errors=True)
        print("\nFrames brutos removidos (--clean).")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
