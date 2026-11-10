"""Collect Editor: local video-editor API and FFmpeg renderer."""
from __future__ import annotations

import json
import math
import shutil
import subprocess
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DATA = ROOT / ".local-data"
UPLOADS = DATA / "uploads"
EXPORTS = DATA / "exports"
MANIFEST = DATA / "clips.json"
for folder in (UPLOADS, EXPORTS):
    folder.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
MAX_PROJECT_SECONDS = 60 * 60
LOCK = threading.RLock()
EXECUTOR = ThreadPoolExecutor(max_workers=1)
app = FastAPI(title="Collect Editor", version="0.1.0")


def _load_clips() -> dict[str, dict]:
    if not MANIFEST.exists():
        return {}
    try:
        entries = json.loads(MANIFEST.read_text(encoding="utf-8"))
        return {item["id"]: item for item in entries if (UPLOADS / item["stored"]).is_file()}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


CLIPS: dict[str, dict] = _load_clips()
JOBS: dict[str, dict] = {}


def _save_clips() -> None:
    temporary = MANIFEST.with_suffix(".tmp")
    temporary.write_text(json.dumps(list(CLIPS.values()), indent=2), encoding="utf-8")
    temporary.replace(MANIFEST)


def _run(command: list[str], *, cwd: Path | None = None) -> None:
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError((result.stderr or "FFmpeg command failed")[-2500:])


def _probe(path: Path) -> tuple[float, bool]:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration:stream=codec_type,duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise ValueError("The file cannot be read by FFprobe.")
    try:
        metadata = json.loads(result.stdout)
        streams = metadata.get("streams", [])
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        if video is None:
            raise ValueError("This file does not contain a video stream.")
        duration = float(metadata.get("format", {}).get("duration") or video.get("duration") or 0)
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("Unable to determine the video duration.")
        audio = any(s.get("codec_type") == "audio" for s in streams)
        return duration, audio
    except (TypeError, KeyError, json.JSONDecodeError) as exc:
        raise ValueError("Could not read media metadata.") from exc


def _encode_segment(source: Path, target: Path, start: float, end: float,
                    has_audio: bool, width: int, height: int) -> None:
    duration = end - start
    video_filter = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30"
    )
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(source),
    ]
    if not has_audio:
        command += ["-f", "lavfi", "-t", f"{duration:.3f}", "-i",
                    "anullsrc=channel_layout=stereo:sample_rate=48000"]
    command += [
        "-map", "0:v:0", "-map", "0:a:0" if has_audio else "1:a:0",
        "-vf", video_filter, "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-shortest", str(target),
    ]
    _run(command)


def _concat(parts: list[Path], destination: Path, workspace: Path) -> None:
    playlist = workspace / "clips.txt"
    playlist.write_text(
        "\n".join(f"file '{part.name}'" for part in parts) + "\n",
        encoding="utf-8",
    )
    _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "concat", "-safe", "0", "-i", str(playlist),
        "-c", "copy", "-movflags", "+faststart", str(destination),
    ], cwd=workspace)


def _render(job_id: str, segments: list[dict], width: int, height: int) -> None:
    destination = EXPORTS / f"{job_id}.mp4"
    try:
        with LOCK:
            JOBS[job_id].update(status="running", progress=0, message="Preparing clips")
        with tempfile.TemporaryDirectory(prefix="collect-") as directory:
            workspace = Path(directory)
            parts: list[Path] = []
            for index, segment in enumerate(segments):
                target = workspace / f"part_{index:03d}.mp4"
                _encode_segment(
                    UPLOADS / segment["stored"], target,
                    segment["start"], segment["end"],
                    segment["has_audio"], width, height,
                )
                parts.append(target)
                with LOCK:
                    JOBS[job_id].update(
                        progress=int((index + 1) / (len(segments) + 1) * 100),
                        message=f"Rendering clip {index + 1} of {len(segments)}",
                    )
            with LOCK:
                JOBS[job_id]["message"] = "Joining clips"
            _concat(parts, destination, workspace)
        with LOCK:
            JOBS[job_id].update(
                status="complete", progress=100, message="Export complete",
                download_url=f"/api/exports/{job_id}/download",
            )
    except Exception as exc:
        destination.unlink(missing_ok=True)
        with LOCK:
            JOBS[job_id].update(status="error", message=str(exc)[-800:])


class Segment(BaseModel):
    clip_id: str
    start: float = Field(ge=0)
    end: float = Field(gt=0)


class ExportRequest(BaseModel):
    segments: list[Segment] = Field(min_length=1, max_length=100)
    resolution: Literal["720p", "1080p"] = "720p"


@app.get("/")
def home():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/static/{filename}")
def static_file(filename: str):
    if filename not in {"style.css", "app.js"}:
        raise HTTPException(404, "Not found")
    return FileResponse(ROOT / "static" / filename)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
    }


@app.get("/api/clips")
def list_clips():
    with LOCK:
        return list(CLIPS.values())


@app.post("/api/clips", status_code=201)
async def upload_clip(file: UploadFile = File(...)):
    original_name = Path((file.filename or "").replace("\\", "/")).name[:150]
    extension = Path(original_name).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, "Upload a supported video format: MP4, MOV, M4V, WebM, MKV or AVI.")
    stored = f"{uuid.uuid4().hex}{extension}"
    destination = UPLOADS / stored
    total = 0
    try:
        with destination.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "The upload exceeds the 2 GB limit.")
                output.write(chunk)
        try:
            duration, has_audio = _probe(destination)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(400, str(exc)) from exc
        clip = {
            "id": uuid.uuid4().hex, "name": original_name, "stored": stored,
            "duration": round(duration, 3), "has_audio": has_audio, "bytes": total,
        }
        with LOCK:
            CLIPS[clip["id"]] = clip
            _save_clips()
        return clip
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await file.close()


@app.get("/api/media/{clip_id}")
def media(clip_id: str):
    with LOCK:
        clip = CLIPS.get(clip_id)
    if not clip:
        raise HTTPException(404, "Clip not found")
    path = UPLOADS / clip["stored"]
    if not path.is_file():
        raise HTTPException(404, "Media file missing")
    return FileResponse(path, filename=clip["name"], content_disposition_type="inline")


@app.delete("/api/clips/{clip_id}")
def delete_clip(clip_id: str):
    with LOCK:
        if any(j["status"] in ("running", "queued") for j in JOBS.values()):
            raise HTTPException(409, "Wait for the current export to finish.")
        clip = CLIPS.pop(clip_id, None)
        if clip:
            _save_clips()
    if not clip:
        raise HTTPException(404, "Clip not found")
    (UPLOADS / clip["stored"]).unlink(missing_ok=True)
    return {"deleted": True}


@app.post("/api/exports", status_code=202)
def start_export(request: ExportRequest):
    with LOCK:
        if any(j["status"] in ("running", "queued") for j in JOBS.values()):
            raise HTTPException(409, "An export is already running.")
        items = []
        total = 0.0
        for part in request.segments:
            clip = CLIPS.get(part.clip_id)
            if not clip:
                raise HTTPException(400, "A timeline clip is missing from the media library.")
            if (not math.isfinite(part.start) or not math.isfinite(part.end)
                    or part.end <= part.start + 0.09
                    or part.end > clip["duration"] + 0.05):
                raise HTTPException(400, f"Invalid trim range for {clip['name']}.")
            total += part.end - part.start
            items.append({**clip, "start": part.start, "end": part.end})
        if total > MAX_PROJECT_SECONDS:
            raise HTTPException(400, "The total timeline must be one hour or less.")
        job_id = uuid.uuid4().hex
        JOBS[job_id] = {
            "id": job_id, "status": "queued", "progress": 0,
            "message": "Waiting to render", "download_url": None,
        }
    width, height = (1920, 1080) if request.resolution == "1080p" else (1280, 720)
    EXECUTOR.submit(_render, job_id, items, width, height)
    return JOBS[job_id]


@app.get("/api/exports/{job_id}")
def export_status(job_id: str):
    with LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(404, "Export not found")
        return dict(job)


@app.get("/api/exports/{job_id}/download")
def download_export(job_id: str):
    with LOCK:
        job = JOBS.get(job_id)
    if job is None or job["status"] != "complete":
        raise HTTPException(404, "Completed export not found")
    return FileResponse(EXPORTS / f"{job_id}.mp4",
                        media_type="video/mp4", filename="Collect-export.mp4")
