"""Layer export tests. Run: python -m unittest discover -s tests -v"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from layer_renderer import build_layer_command, render_layers


class LayerCommandTests(unittest.TestCase):
    def test_video_and_audio_filters_present(self):
        layers = [
            {"track": "V2", "start": 0, "end": 1, "at": 0.25,
             "stored": "overlay.mp4", "volume": 1},
            {"track": "A1", "start": 0, "end": 1, "at": 0.50,
             "stored": "music.wav", "volume": 0.5},
        ]
        command = build_layer_command(
            Path("base.mp4"), Path("out.mp4"), layers,
            Path("uploads"), 320, 180, 2.0
        )
        graph = command[command.index("-filter_complex") + 1]
        self.assertIn("overlay=x=198:y=111", graph)
        self.assertIn("scale=108:60", graph)
        self.assertIn("amix=inputs=2", graph)
        self.assertIn("adelay=500:all=1", graph)
        self.assertIn("volume=0.500", graph)
        self.assertIn("[vout0]", command)
        self.assertIn("[mixed]", command)

    def test_custom_overlay_geometry_uses_normalized_frame_coordinates(self):
        command = build_layer_command(
            Path("base.mp4"), Path("out.mp4"),
            [{"track": "V2", "start": 0, "end": 1, "at": 0.25,
              "stored": "overlay.mp4", "volume": 1,
              "x": 0.1, "y": 0.2, "w": 0.6, "h": 0.5}],
            Path("uploads"), 320, 180, 2.0
        )
        graph = command[command.index("-filter_complex") + 1]
        self.assertIn("scale=192:90", graph)
        self.assertIn("pad=192:90", graph)
        self.assertIn("overlay=x=32:y=36", graph)

    def test_audio_only_copies_base_video(self):
        command = build_layer_command(
            Path("base.mp4"), Path("out.mp4"),
            [{"track": "A2", "start": 0, "end": 1, "at": 0,
              "stored": "effect.wav", "volume": 1}],
            Path("uploads"), 320, 180, 2
        )
        self.assertIn("0:v:0", command)
        self.assertIn("copy", command)
        self.assertIn("[mixed]", command)

    def test_clip_after_sequence_is_skipped(self):
        command = build_layer_command(
            Path("base.mp4"), Path("out.mp4"),
            [{"track": "A1", "start": 0, "end": 1, "at": 5,
              "stored": "music.wav", "volume": 1}],
            Path("uploads"), 320, 180, 2
        )
        self.assertNotIn("-filter_complex", command)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                     "FFmpeg and FFprobe required")
class LayerRenderTests(unittest.TestCase):
    def _run(self, command):
        process = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr[-2000:])

    def test_picture_in_picture_and_audio_mix_render(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            self._run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=2",
                "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", str(directory / "base.mp4")
            ])
            self._run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=yellow:s=160x90:r=30:d=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                str(directory / "overlay.mp4")
            ])
            self._run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "sine=frequency=880:duration=1.4",
                str(directory / "music.wav")
            ])
            overlays = [
                {"track": "V2", "start": 0, "end": 1, "at": 0.3,
                 "stored": "overlay.mp4", "volume": 1.0},
                {"track": "A1", "start": 0, "end": 1.4, "at": 0.3,
                 "stored": "music.wav", "volume": 0.5},
            ]
            destination = directory / "layered.mp4"
            render_layers(
                directory / "base.mp4", destination, overlays, directory,
                320, 180, 2.0
            )
            self.assertTrue(destination.is_file())
            process = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries",
                "format=duration:stream=codec_type,codec_name",
                "-of", "json", str(destination)
            ], capture_output=True, text=True, check=True)
            metadata = json.loads(process.stdout)
            codecs = {stream["codec_name"] for stream in metadata["streams"]}
            self.assertIn("h264", codecs)
            self.assertIn("aac", codecs)
            self.assertAlmostEqual(float(metadata["format"]["duration"]), 2.0, delta=0.2)


if __name__ == "__main__":
    unittest.main()
