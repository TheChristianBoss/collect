# Collect Editor v0.4 — overlay controls, transitions and waveforms

A new local-first browser-based editor in this repository's `collect-editor/` folder. Kdenlive, LosslessCut, OpenShot and Shotcut remain independent and untouched.

## Features

- Import MP4, MOV, M4V, WebM, MKV, AVI, MP3, WAV, M4A, AAC, FLAC, OGG and OPUS files.
- Preview video and audio with the browser's built-in codecs (some formats require FFmpeg export to view reliably).
- Arrange V1 clips, trim, split at the playhead, duplicate, undo/redo, zoom, and scrub.
- **V2 Overlay**: move and resize picture-in-picture video anywhere in the frame by dragging the overlay and its corner resize handle in the preview. You can also set X/Y/width/height as percentages in the layer inspector. The placement is saved and used in MP4 export.
- **A1 Music and A2 Effects**: add timed audio clips and mix them with V1's existing audio. Each clip has individual source trims, position and volume (0–200% for export). Audio clips show approximate waveforms (generated via FFmpeg, up to 600 amplitude buckets).
- Drag V2/A1/A2 clips horizontally or edit their positions numerically.
- Select **Cut** or **Fade through black** for the transition into a V1 clip. Fade length applies to each side of the cut (0.1–1.5 seconds); final duration does not change.
- Export MP4 with H.264 video and AAC audio at 720p or 1080p.
- Browser local-storage timeline autosave. Media stays on the local computer under the ignored `.local-data/` folder.

## Track model

| Track | Media | Purpose |
| --- | --- | --- |
| V2 | Video only | Draggable/resizable picture-in-picture overlay |
| V1 | Video only | Main sequential footage; sets project length |
| A1 | Media with audio | Music or another soundtrack |
| A2 | Media with audio | Sound effects or another soundtrack |

In **Media library → ADD MEDIA TO**, choose the track and click **+** on a media item. Select clips to edit placement and trim in the right inspector. The V1 base sequence determines final duration. Additional layers extending beyond V1 are truncated (or skipped if entirely outside it). Overlay-video audio is not automatically mixed; to hear it, add that same source to an audio track.

### v0.4 controls

To reposition an active V2 clip, select it in the V2 lane, play or scrub to a time when it is visible, and **drag the overlay in the preview**. Drag the small corner handle to resize it. You may also type its **X, Y, Width and Height** in the inspector. Coordinates use percentages of the 16:9 output frame. Overlays must remain inside the frame and be at least 5% wide and tall.

Select a V1 clip *after the first* and choose its **Transition into this clip** in the inspector. A **Fade through black** fades the preceding clip out and the selected clip in, including audio; it is **not a cross-dissolve**. The transition does not shorten the project. Clip splits create hard cuts at the split point.

Audio waveforms on A1 and A2 are approximations generated from resampled audio. They are cached under `.local-data/waveforms/` and displayed only when FFmpeg is available. Source audio beyond one hour is not analyzed for waveform display, though project exports are already limited to one hour.

### Timeline shortcuts

| Command | Shortcut / action |
| --- | --- |
| Split V1 clip at playhead | **S** or **Split** |
| Undo/redo | **Ctrl+Z / Ctrl+Y** or **Cmd+Z / Cmd+Shift+Z** |
| Delete selected V1 clip | **Delete** |
| Preview V1 | **Space** |
| Move V1 clip | Drag or use **Earlier/Later** |
| Move overlay/audio clip | Drag it horizontally or change **Timeline start** |
| Zoom | Timeline zoom slider or **+ / −** controls |
| Scrub | Project scrubber or click within a V1 clip |

## Install and run on Windows (VS Code)

Requires Python 3.10+, FFmpeg + FFprobe on the system PATH, and a modern browser. First verify:

```powershell
python --version
ffmpeg -version
ffprobe -version
```

From the cloned **Collect** repo, on the `feature/collect-editor-mvp` branch:

```powershell
cd collect-editor
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open **http://127.0.0.1:8000**. The app runs only on your computer; it is not a public website.

## macOS / Linux

```bash
cd collect-editor
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

## Tests

Run the Node timeline unit tests with Node 18+:

```bash
node --test tests/timeline-core.test.js
```

Run Python renderer unit tests; the integration smoke test automatically skips if FFmpeg/FFprobe are missing:

```bash
python -m unittest discover -s tests -v
```

## Architecture

- `app.py`: localhost FastAPI media library, validation and export jobs.
- `layer_renderer.py`: FFmpeg filter graph that overlays and scales/repositions V2 and mixes A1/A2 with V1 audio.
- `static/index.html`, `style.css`, `app.js`: editor, V1 timeline, preview and export.
- `static/timeline-core.js`: pure V1 split/reorder/seek algorithms.
- `static/layers.js`: V2/A1/A2 tracks, waveform drawing, movable/resizable overlay preview, inspector and saved metadata.
- `tests/`: Node timeline unit tests and Python render smoke tests.

## Known limitations

- V2 supports independent positioning and resizing within a single fixed 16:9 output frame, but there is no rotation, chroma key, motion tracking or keyframe animation.
- The video output duration comes only from V1. Timeline length is limited to one hour, with up to 100 V1 and 100 supplementary clips; uploads are limited to 2 GB per file.
- Browser playback of multiple tracks is best-effort; the FFmpeg render is authoritative. Browser audio preview caps volume at 100%, while export supports 200%.
- Video overlays are muted in the preview and their audio is excluded from export unless separately placed on A1/A2.
- Timeline metadata is saved in the current browser, not as portable project files. Deleting browser storage loses timeline edits. Media files persist in `.local-data/`.
- Transitions currently offer only hard cuts and fades through black; there are no cross-dissolves, title generator, keyframes, full effects stack, or standalone installer yet.
- No sign-in or authentication: **do not expose the development server to the public internet.**

## Licensing

This is a separate implementation, not a code merge of the four upstream editors. Their original licenses remain inside their respective folders. Reusing code from those projects would require appropriate license and attribution review.
