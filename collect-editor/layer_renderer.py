"""Compose a rendered V1 sequence with timed V2 video overlays and A1/A2 audio.

The V1 movie is already normalized to H.264/AAC by app.py. Each overlay
is placed as picture-in-picture at the bottom-right. A1/A2 layers are mixed
with V1's soundtrack. This is intentionally a simple v0.3 compositor.
"""
from __future__ import annotations

import subprocess
from pathlib import Path


def build_layer_command(
    base: Path,
    output: Path,
    layers: list[dict],
    uploads: Path,
    width: int,
    height: int,
    duration: float,
) -> list[str]:
    """Build an FFmpeg command without running it (unit-test friendly)."""
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
               "-i", str(base)]
    video_layers = []
    audio_layers = []
    for layer in layers:
        # All layer metadata and media paths have been validated by the API.
        # Truncate clips that extend beyond the V1 sequence.
        length = min(layer["end"] - layer["start"], duration - layer["at"])
        if length <= 0.0005:
            continue
        index = 1 + len(video_layers) + len(audio_layers)
        command += [
            "-ss", f"{layer['start']:.3f}",
            "-t", f"{length:.3f}",
            "-i", str(uploads / layer["stored"]),
        ]
        (video_layers if layer["track"] == "V2" else audio_layers).append(
            (index, layer, length)
        )

    filters: list[str] = []
    video_out = "0:v:0"
    if video_layers:
        filters.append("[0:v:0]setpts=PTS-STARTPTS[vbase]")
        video_out = "vbase"
        for number, (index, layer, length) in enumerate(video_layers):
            at = layer["at"]
            end = at + length
            scaled = f"ov{number}"
            next_out = f"vout{number}"
            filters.append(
                f"[{index}:v:0]setpts=PTS-STARTPTS+{at:.3f}/TB,"
                f"scale={max(2, width * 36 // 100 // 2 * 2)}:"
                f"{max(2, height * 36 // 100 // 2 * 2)}:"
                "force_original_aspect_ratio=decrease,"
                f"setsar=1,format=yuv420p[{scaled}]"
            )
            filters.append(
                f"[{video_out}][{scaled}]"
                "overlay=x=W-w-24:y=H-h-24:shortest=0:"
                f"eof_action=pass:repeatlast=0:"
                f"enable='between(t,{at:.3f},{end:.3f})'[{next_out}]"
            )
            video_out = next_out

    audio_out = "0:a:0"
    if audio_layers:
        filters.append(
            "[0:a:0]aresample=48000,aformat=channel_layouts=stereo,"
            "asetpts=PTS-STARTPTS[abase]"
        )
        refs = ["[abase]"]
        for number, (index, layer, length) in enumerate(audio_layers):
            label = f"aud{number}"
            at = layer["at"]
            delay = int(round(at * 1000))
            volume = layer["volume"]
            filters.append(
                f"[{index}:a:0]aresample=48000,"
                "aformat=channel_layouts=stereo,"
                f"asetpts=PTS-STARTPTS,volume={volume:.3f},"
                f"atrim=duration={length:.3f},"
                f"adelay={delay}:all=1[{label}]"
            )
            refs.append(f"[{label}]")
        filters.append(
            "".join(refs)
            + f"amix=inputs={len(refs)}:duration=first:"
              "normalize=0:dropout_transition=0,"
              "alimiter=limit=0.95[mixed]"
        )
        audio_out = "mixed"

    if filters:
        command += ["-filter_complex", ";".join(filters)]
    command += ["-map", f"[{video_out}]" if video_layers else "0:v:0"]
    command += ["-map", f"[{audio_out}]" if audio_layers else "0:a:0"]
    if video_layers:
        command += ["-c:v", "libx264", "-preset", "veryfast",
                    "-crf", "23", "-pix_fmt", "yuv420p"]
    else:
        command += ["-c:v", "copy"]
    if audio_layers:
        command += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
    else:
        command += ["-c:a", "copy"]
    command += ["-t", f"{duration:.3f}", "-movflags", "+faststart", str(output)]
    return command


def render_layers(
    base: Path,
    output: Path,
    layers: list[dict],
    uploads: Path,
    width: int,
    height: int,
    duration: float,
) -> None:
    if not layers:
        # Caller may have already rendered directly into output.
        if base.resolve() != output.resolve():
            import shutil
            shutil.copy2(base, output)
        return
    command = build_layer_command(base, output, layers, uploads,
                                  width, height, duration)
    process = subprocess.run(command, capture_output=True,
                             text=True, check=False)
    if process.returncode:
        raise RuntimeError(
            "Layered FFmpeg rendering failed: "
            + (process.stderr or "Unknown FFmpeg error")[-2500:]
        )
