"""Regression tests for transition commands and waveform generation."""
from __future__ import annotations

import shutil
import subprocess
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import app as editor


class TransitionTests(unittest.TestCase):
    @patch("app._run")
    def test_fade_in_and_out_apply_to_both_video_and_audio(self, run):
        editor._encode_segment(
            Path("source.mp4"), Path("out.mp4"), 0, 2,
            has_audio=True, width=320, height=180,
            fade_in=0.45, fade_out=0.45,
        )
        command = run.call_args.args[0]
        video_filter = command[command.index("-vf") + 1]
        audio_filter = command[command.index("-af") + 1]
        self.assertIn("fade=t=in:st=0:d=0.450", video_filter)
        self.assertIn("fade=t=out:st=1.550:d=0.450", video_filter)
        self.assertIn("afade=t=in:st=0:d=0.450", audio_filter)
        self.assertIn("afade=t=out:st=1.550:d=0.450", audio_filter)

    @patch("app._run")
    def test_hard_cut_does_not_add_fade_filters(self, run):
        editor._encode_segment(
            Path("source.mp4"), Path("out.mp4"), 0, 2,
            has_audio=False, width=320, height=180,
        )
        command = run.call_args.args[0]
        self.assertNotIn("-af", command)
        self.assertNotIn("fade=t=", command[command.index("-vf") + 1])


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                     "FFmpeg/FFprobe not installed")
class WaveformTests(unittest.TestCase):
    def test_audio_waveform_is_generated_and_cached(self):
        identifier = uuid.uuid4().hex
        filename = identifier + ".wav"
        source = editor.UPLOADS / filename
        cache = editor.WAVEFORMS / (identifier + ".json")
        try:
            process = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                 "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5",
                 str(source)],
                capture_output=True, text=True
            )
            self.assertEqual(process.returncode, 0, process.stderr[-800:])
            editor.CLIPS[identifier] = {
                "id": identifier, "name": filename, "stored": filename,
                "duration": 0.5, "has_audio": True, "kind": "audio"
            }
            result = editor.waveform(identifier)
            self.assertTrue(result["peaks"])
            self.assertGreater(max(result["peaks"]), 0.01)
            self.assertTrue(cache.exists())
            self.assertEqual(result, editor.waveform(identifier))
        finally:
            editor.CLIPS.pop(identifier, None)
            source.unlink(missing_ok=True)
            cache.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
