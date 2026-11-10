# Collect Browser Edition (v0.5)

A **browser-only** version of the Collect Editor, designed to be hosted on **GitHub Pages**. It retains the Collect timeline UI and V1/V2/A1/A2 track model, but removes the need for a running Python server.

## How it works

- React or a Python backend is **not** required. The frontend uses Collect's existing vanilla JavaScript timeline and a small Vite build.
- Videos and audio are imported into **IndexedDB** in your own browser. Blob URLs power local video preview.
- Timeline edits, fades, overlay positioning, trims, and layer settings are saved to **localStorage** in that same browser (portable project JSON is not yet implemented).
- Browser MP4 exports use the **single-thread @ffmpeg/core WebAssembly** renderer. The FFmpeg engine is bundled with the site and downloaded only when needed. No media files are uploaded to a server.
- Audio waveforms use the browser Web Audio API where supported. Non-browser-decodable audio media may show no waveforms.

## Develop locally

Install Node.js 20 or newer and run:

```bash
cd collect-editor/web
npm install
npm run dev
```

Visit the local URL printed by Vite (typically http://127.0.0.1:5173).

## Build for GitHub Pages

```bash
npm run build
```

The static site is generated in `collect-editor/web/dist/`.
The repo contains `.github/workflows/collect-browser-pages.yml` to deploy that folder after changes are merged to `main`.

**One-time repository setting:** In GitHub, open **Settings → Pages → Build and deployment → Source: GitHub Actions**. The workflow publishes the site at the repository's GitHub Pages address if Pages is enabled.

## Browser edition differences

| Capability | Browser Edition | Existing local Python edition |
| --- | --- | --- |
| Hosting | GitHub Pages / static sites | Local FastAPI server |
| File storage | IndexedDB in browser | `.local-data/` on local PC |
| Project metadata | Browser localStorage | Browser localStorage |
| Export renderer | FFmpeg.wasm single-thread core | Native FFmpeg |
| Typical performance | Slower; memory constrained | Faster, larger source files |
| Output | MP4, 360p/480p/720p/1080p | MP4, 720p/1080p |

## Current browser constraints

- A browser must support IndexedDB, WebAssembly and the video format used for preview.
- Up to **250 MB per imported file**, 600 MB total media, and **10 minutes per export**. Browser and device memory may impose lower limits.
- 480p is the recommended export starting point. Large 1080p projects may fail or freeze on lower-memory devices.
- Browser audio-track metadata for source videos is sometimes unavailable until export, when FFprobe inspects source streams.
- The FFmpeg WebAssembly core is a large download, and conversion can take longer than the video duration.
- The existing **Python edition remains intact** under `collect-editor/` and can handle larger jobs.
- Future work: portable project files, delete-media library controls, better mobile interactions, cross-dissolves, true multi-track video compositing.

## Security

Files are processed on your device. The GitHub Pages host serves the JS/CSS/WASM assets, not your clips. Clearing site storage loses imported files and timeline metadata. Imported media is not synced across devices.

## FFmpeg

Uses official `@ffmpeg/ffmpeg` and single-thread `@ffmpeg/core` v0.12.10.
Multi-thread FFmpeg requires cross-origin isolation headers that standard GitHub Pages cannot be configured to supply; single-thread mode avoids that requirement.
