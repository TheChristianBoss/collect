# Collect Editor (MVP)

A **new, standalone** video editor inside the Collect repository. The four imported upstream applications in sibling folders are unchanged.

## Features in v0.1
- Import local MP4, MOV, M4V, WebM, MKV or AVI videos into a private local media library
- Preview videos using the browser's built-in playback (codec support depends on your browser)
- Add a source multiple times to the timeline, reorder clips, remove clips, and trim start/end in seconds
- Export clips in timeline order into a single H.264/AAC MP4, at 720p or 1080p
- Letterbox/pillarbox clips to the chosen 16:9 frame; standardize each segment to 30 fps
- Add silent audio to clips that have no audio, for compatible joining

## Requirements
- Python 3.10+
- FFmpeg and FFprobe installed and available on your PATH
- A modern browser such as Chrome, Edge or Firefox
- At least several GB of available disk space for temporary renders and project media

On Windows, install Python and FFmpeg, then **restart your terminal**. Check:

\`\`\`powershell
python --version
ffmpeg -version
ffprobe -version
\`\`\`

## Run on Windows (VS Code / PowerShell)

From your cloned **Collect** repository folder:

\`\`\`powershell
cd collect-editor
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
\`\`\`

Open **http://127.0.0.1:8000**.

If PowerShell blocks virtual environment activation, run the following instead of activating:

\`\`\`powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
\`\`\`

## Run on macOS / Linux

\`\`\`bash
cd collect-editor
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
\`\`\`

The app runs **on your computer**, not on a hosted website. Uploaded files and exports are stored under ignored \`.local-data/\`, not in GitHub. The API binds to localhost by default.

## Architecture
- \`app.py\`: FastAPI endpoints for imports, media, renders, and downloads
- \`static/index.html\`, \`style.css\`, \`app.js\`: dependency-free web editor
- Each source is stored under a random filename. Exports use temporary transcodes for consistent resolution, framerate, audio format, and codec, then FFmpeg's concat demuxer.

## Known limitations
- The source library persists across restarts, but **timeline edits are not yet saved**.
- Clip preview uses native browser codecs; some MOV/MKV files may export successfully but not preview.
- Timeline preview plays clips in sequence, but export accuracy may differ slightly at transition boundaries because of frame rounding and re-encoding.
- No effects, titles, audio mixing, transitions, undo history, waveforms, or keyframes yet.
- No authentication. Do **not** expose this development server to the public internet.
- Upload size limit is 2 GB per file; maximum export duration is one hour. Exports run one at a time.
- Output is fixed 16:9 at 30 fps.

## Licensing
This new implementation is separate from Kdenlive, LosslessCut, OpenShot, and Shotcut. Their original licenses remain in their individual directories. Before distributing a binary incorporating components from those projects, review applicable licenses and attribution requirements.
