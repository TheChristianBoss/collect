import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core/dist/esm/ffmpeg-core.js?url";
import wasmURL from "@ffmpeg/core/dist/esm/ffmpeg-core.wasm?url";

/*
 * Collect Browser API
 * A local-browser replacement for the Python /api routes used by the
 * existing Collect timeline UI. Media lives in IndexedDB; exporting runs
 * the single-thread FFmpeg WebAssembly core inside a web worker.
 */
const DB_NAME = "collect-editor-browser-v1";
const MEDIA_STORE = "media";
const FILE_LIMIT = 250 * 1024 * 1024; // Browser WASM memory budget
const TOTAL_MEDIA_LIMIT = 600 * 1024 * 1024;
const MAX_EXPORT_SECONDS = 600; // Large browser renders can exhaust memory
const AUDIO_EXT = new Set(["mp3", "m4a", "wav", "aac", "flac", "ogg", "opus"]);
const ACCEPTED = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", ...AUDIO_EXT]);
const resolutionMap = {
  "360p": [640, 360], "480p": [854, 480],
  "720p": [1280, 720], "1080p": [1920, 1080]
};
const enc = new TextEncoder();
const dec = new TextDecoder();
const round = (number) => Math.round(number * 1000) / 1000;
const cleanName = (name) => String(name || "media").split(/[\\/]/).pop().slice(0, 150);
const extOf = (name) => cleanName(name).split(".").pop().toLowerCase();

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        db.createObjectStore(MEDIA_STORE, {keyPath: "id"});
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || Error("IndexedDB unavailable"));
  });
}
function dbGetAll(db) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(MEDIA_STORE, "readonly")
      .objectStore(MEDIA_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || Error("Cannot open media library"));
  });
}
function dbPut(db, item) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MEDIA_STORE, "readwrite");
    transaction.objectStore(MEDIA_STORE).put(item);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || Error("Media storage is full"));
    transaction.onabort = () => reject(transaction.error || Error("Media storage failed"));
  });
}
function probeBrowser(file, kind) {
  const url = URL.createObjectURL(file);
  const element = document.createElement(kind === "audio" ? "audio" : "video");
  element.preload = "metadata";
  element.muted = true;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, seconds) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(round(seconds));
    };
    const timer = setTimeout(
      () => finish(Error("The browser could not read this file's duration.")),
      15000
    );
    element.onloadedmetadata = () => {
      const seconds = element.duration;
      if (!Number.isFinite(seconds) || seconds <= 0) {
        finish(Error("This media file has no readable duration."));
      } else finish(null, seconds);
    };
    element.onerror = () => finish(
      Error("This format cannot be previewed in your browser. Try an MP4 (H.264) or MP3.")
    );
    element.src = url;
  });
}
function safeFileName(id, media) {
  return "source_" + id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 50)
    + "." + (ACCEPTED.has(extOf(media.name)) ? extOf(media.name) : "mp4");
}
function ensureOk(exit, action) {
  if (exit !== 0) throw Error(action + " failed in FFmpeg (exit code " + exit + ").");
}

export class BrowserAPI {
  constructor() {
    this.db = null;
    this.media = new Map();
    this.objectURLs = new Map();
    this.jobs = new Map();
    this.ffmpeg = null;
    this.rendering = false;
    this.exportURL = null;
    this.probed = new Map();
  }
  async init() {
    if (!("indexedDB" in window)) {
      throw Error("IndexedDB is required to save media in the browser.");
    }
    this.db = await openDatabase();
    const all = await dbGetAll(this.db);
    all.forEach((item) => this.media.set(item.id, item));
  }
  async request(path, options = {}) {
    if (path === "/api/health") {
      return {status: "ok", ffmpeg: true, engine: "browser-wasm"};
    }
    if (path === "/api/clips" && (!options.method || options.method === "GET")) {
      return [...this.media.values()].map((item) => item.meta);
    }
    if (path === "/api/clips" && options.method === "POST") {
      return this.importFile(options.body?.get?.("file"));
    }
    if (path === "/api/exports" && options.method === "POST") {
      const request = JSON.parse(options.body || "{}");
      return this.createExport(request);
    }
    const exportStatus = /^\/api\/exports\/([a-z0-9-]+)$/.exec(path);
    if (exportStatus) {
      const job = this.jobs.get(exportStatus[1]);
      if (!job) throw Error("Export job not found.");
      return {...job};
    }
    throw Error("Unknown browser route: " + path);
  }
  async importFile(file) {
    if (!(file instanceof Blob)) throw Error("Select a video or audio file.");
    const name = cleanName(file.name || "media");
    const ext = extOf(name);
    if (!ACCEPTED.has(ext)) throw Error("Unsupported file type: " + ext);
    if (!file.size) throw Error("File is empty.");
    if (file.size > FILE_LIMIT) {
      throw Error("Browser Edition currently limits each imported file to 250 MB.");
    }
    const existingSize = [...this.media.values()].reduce(
      (total, item) => total + item.blob.size, 0
    );
    if (existingSize + file.size > TOTAL_MEDIA_LIMIT) {
      throw Error("Browser storage limit: 600 MB total. Clear old browser data to free space.");
    }
    const kind = AUDIO_EXT.has(ext) || file.type.startsWith("audio/") ? "audio" : "video";
    const duration = await probeBrowser(file, kind);
    const id = crypto.randomUUID();
    const meta = {
      id, name, bytes: file.size, duration, kind,
      // Video stream audio is inspected precisely by ffprobe at export time.
      // The browser does not consistently expose audio-track metadata.
      has_audio: true
    };
    const item = {id, meta, blob: file};
    await dbPut(this.db, item);
    this.media.set(id, item);
    return meta;
  }
  getMediaURL(id) {
    if (this.objectURLs.has(id)) return this.objectURLs.get(id);
    const item = this.media.get(id);
    if (!item) throw Error("Media is missing from your browser.");
    const url = URL.createObjectURL(item.blob);
    this.objectURLs.set(id, url);
    return url;
  }
  async getWaveform(id) {
    const item = this.media.get(id);
    if (!item) return {duration: 0, peaks: []};
    if (item.blob.size > 35 * 1024 * 1024) {
      return {duration: item.meta.duration, peaks: []};
    }
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) return {duration: item.meta.duration, peaks: []};
    const context = new AudioContextConstructor();
    try {
      const decoded = await context.decodeAudioData(await item.blob.arrayBuffer());
      const samples = decoded.getChannelData(0);
      const buckets = Math.min(600, samples.length);
      const peaks = [];
      for (let index = 0; index < buckets; index++) {
        const start = Math.floor(index * samples.length / buckets);
        const end = Math.max(start + 1, Math.floor((index + 1) * samples.length / buckets));
        let max = 0;
        // Sample at most 1500 points per bucket to avoid blocking the UI.
        const step = Math.max(1, Math.floor((end - start) / 1500));
        for (let sample = start; sample < end; sample += step) {
          max = Math.max(max, Math.abs(samples[sample]));
        }
        peaks.push(round(max));
      }
      return {duration: decoded.duration, peaks};
    } catch {
      return {duration: item.meta.duration, peaks: []};
    } finally {
      await context.close();
    }
  }
  async loadFFmpeg(job) {
    if (this.ffmpeg?.loaded) return this.ffmpeg;
    job.message = "Downloading browser FFmpeg engine (large first download)…";
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({coreURL, wasmURL});
    this.ffmpeg = ffmpeg;
    return ffmpeg;
  }
  async probeMedia(ffmpeg, filename) {
    const output = filename + ".json";
    try {
      const result = await ffmpeg.ffprobe([
        "-v", "error", "-show_streams", "-show_format",
        "-print_format", "json", filename, "-o", output
      ]);
      ensureOk(result, "Media inspection");
      const json = JSON.parse(dec.decode(await ffmpeg.readFile(output)));
      return {
        video: json.streams?.some((stream) => stream.codec_type === "video") || false,
        audio: json.streams?.some((stream) => stream.codec_type === "audio") || false
      };
    } finally {
      try { await ffmpeg.deleteFile(output); } catch {}
    }
  }
  createExport(request) {
    if (this.rendering) throw Error("An export is already running.");
    if (!Array.isArray(request.segments) || !request.segments.length) {
      throw Error("Add at least one video to V1 before exporting.");
    }
    if (!resolutionMap[request.resolution]) throw Error("Invalid output resolution.");
    if (request.segments.length > 100 || (request.layers || []).length > 100) {
      throw Error("This project has too many clips for the browser exporter.");
    }
    const total = request.segments.reduce((sum, seg) => {
      const item = this.media.get(seg.clip_id);
      if (!item || item.meta.kind !== "video") throw Error("V1 references missing video media.");
      if (!(seg.start >= 0 && seg.end - seg.start >= 0.1
        && seg.end <= item.meta.duration + 0.05)) {
        throw Error("Invalid V1 trim range.");
      }
      return sum + seg.end - seg.start;
    }, 0);
    if (total > MAX_EXPORT_SECONDS) {
      throw Error("Browser Edition currently limits exports to 10 minutes.");
    }
    for (const layer of request.layers || []) {
      const item = this.media.get(layer.clip_id);
      if (!item) throw Error("A layer references missing media.");
      if (!["V2", "A1", "A2"].includes(layer.track)) throw Error("Invalid layer track.");
      if (!(layer.at >= 0 && layer.at < total && layer.start >= 0
        && layer.end - layer.start >= 0.1
        && layer.end <= item.meta.duration + 0.05)) {
        throw Error("Invalid layer timing.");
      }
      if (layer.track === "V2" && item.meta.kind !== "video") {
        throw Error("V2 overlays must contain video.");
      }
      const {x = 0.62, y = 0.62, w = 0.34, h = 0.34} = layer;
      if (![x,y,w,h].every(Number.isFinite) || x < 0 || y < 0
        || w < 0.05 || h < 0.05 || x+w > 1.00001 || y+h > 1.00001) {
        throw Error("Overlay must fit within the output frame.");
      }
    }
    const id = crypto.randomUUID().replace(/-/g, "");
    const job = {
      id, status: "queued", progress: 0,
      message: "Preparing browser render", download_url: null
    };
    this.jobs.set(id, job);
    this.rendering = true;
    // Start on the next task so the queued status renders before computation.
    setTimeout(() => this.runExport(request, job)
      .catch((error) => {
        job.status = "error";
        job.message = error?.message || String(error);
      })
      .finally(() => { this.rendering = false; }), 0);
    return {...job};
  }
  async runExport(request, job) {
    job.status = "running";
    const ffmpeg = await this.loadFFmpeg(job);
    const [width, height] = resolutionMap[request.resolution];
    const parts = request.segments;
    const total = parts.reduce((sum, item) => sum + item.end - item.start, 0);
    const layers = request.layers || [];
    const allIds = [...new Set([...parts, ...layers].map((item) => item.clip_id))];
    const sourcePaths = new Map();
    const created = [];
    const stageCount = parts.length + (layers.length ? 2 : 1);
    let completed = 0;
    const advance = (label) => {
      completed++;
      job.progress = Math.min(98, Math.floor(98 * completed / stageCount));
      job.message = label;
    };
    try {
      for (const id of allIds) {
        const media = this.media.get(id);
        const filename = safeFileName(id, media.meta);
        sourcePaths.set(id, filename);
        job.message = "Loading media into browser video engine…";
        await ffmpeg.writeFile(filename, new Uint8Array(await media.blob.arrayBuffer()));
        created.push(filename);
        this.probed.set(id, await this.probeMedia(ffmpeg, filename));
      }
      const transcoded = [];
      for (let index = 0; index < parts.length; index++) {
        const segment = parts[index];
        const name = "v1_part_" + index + ".mp4";
        const path = sourcePaths.get(segment.clip_id);
        const probe = this.probed.get(segment.clip_id);
        const length = segment.end - segment.start;
        const fadeIn = index > 0 && segment.transition === "fade"
          ? Math.min(segment.fade_seconds || 0.45, length * 0.45) : 0;
        const following = parts[index + 1];
        const fadeOut = following?.transition === "fade"
          ? Math.min(following.fade_seconds || 0.45, length * 0.45) : 0;
        const vf = [
          "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease",
          "pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2",
          "setsar=1", "fps=30"
        ];
        const af = [];
        if (fadeIn > 0) {
          vf.push("fade=t=in:st=0:d=" + fadeIn.toFixed(3));
          af.push("afade=t=in:st=0:d=" + fadeIn.toFixed(3));
        }
        if (fadeOut > 0) {
          const at = Math.max(0, length - fadeOut).toFixed(3);
          vf.push("fade=t=out:st=" + at + ":d=" + fadeOut.toFixed(3));
          af.push("afade=t=out:st=" + at + ":d=" + fadeOut.toFixed(3));
        }
        const args = [
          "-ss", segment.start.toFixed(3), "-t", length.toFixed(3),
          "-i", path
        ];
        if (!probe.audio) {
          args.push("-f", "lavfi", "-t", length.toFixed(3),
            "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
        }
        args.push("-map", "0:v:0", "-map", probe.audio ? "0:a:0" : "1:a:0",
          "-vf", vf.join(","));
        if (af.length) args.push("-af", af.join(","));
        args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
          "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
          "-ar", "48000", "-ac", "2", "-shortest", name);
        job.message = "Rendering main clip " + (index + 1) + " / " + parts.length;
        ensureOk(await ffmpeg.exec(args), "Main video segment " + (index + 1));
        created.push(name);
        transcoded.push(name);
        advance("Rendered " + (index + 1) + " main clips");
      }
      const playlist = transcoded.map((name) => "file '" + name + "'").join("\n") + "\n";
      const listPath = "concat.txt";
      await ffmpeg.writeFile(listPath, enc.encode(playlist));
      created.push(listPath);
      const basePath = "base.mp4";
      ensureOk(await ffmpeg.exec([
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-c", "copy", "-movflags", "+faststart", basePath
      ]), "Joining main clips");
      created.push(basePath);
      advance("Joining timeline");
      let target = basePath;
      if (layers.length) {
        target = "collect-final.mp4";
        const command = this.layerCommand(
          layers, sourcePaths, width, height, total, target
        );
        job.message = "Mixing overlay and audio tracks…";
        ensureOk(await ffmpeg.exec(command), "Combining extra tracks");
        created.push(target);
        advance("Compositing complete");
      }
      const output = await ffmpeg.readFile(target);
      if (this.exportURL) URL.revokeObjectURL(this.exportURL);
      this.exportURL = URL.createObjectURL(
        new Blob([output.buffer], {type: "video/mp4"})
      );
      job.status = "complete";
      job.progress = 100;
      job.message = "Export complete! Download your MP4.";
      job.download_url = this.exportURL;
    } finally {
      for (const path of created.reverse()) {
        try { await ffmpeg.deleteFile(path); } catch {}
      }
      this.probed.clear();
    }
  }
  layerCommand(layers, sourcePaths, width, height, duration, output) {
    const input = ["-i", "base.mp4"];
    const videoLayers = [];
    const audioLayers = [];
    let inputIndex = 1;
    for (const layer of layers) {
      const length = Math.min(layer.end - layer.start, duration - layer.at);
      if (length <= 0) continue;
      const path = sourcePaths.get(layer.clip_id);
      input.push("-ss", layer.start.toFixed(3), "-t", length.toFixed(3), "-i", path);
      (layer.track === "V2" ? videoLayers : audioLayers).push(
        {index: inputIndex, layer, length}
      );
      inputIndex++;
    }
    const graph = [];
    let videoOut = "0:v:0";
    if (videoLayers.length) {
      graph.push("[0:v:0]setpts=PTS-STARTPTS[vbase]");
      videoOut = "vbase";
      videoLayers.forEach(({index, layer, length}, number) => {
        const rectWidth = Math.max(2, Math.floor(width * (layer.w ?? 0.34) / 2) * 2);
        const rectHeight = Math.max(2, Math.floor(height * (layer.h ?? 0.34) / 2) * 2);
        const x = Math.floor(width * (layer.x ?? 0.62));
        const y = Math.floor(height * (layer.y ?? 0.62));
        const name = "ov" + number;
        const next = "vout" + number;
        graph.push("[" + index + ":v:0]setpts=PTS-STARTPTS+"
          + layer.at.toFixed(3) + "/TB,scale=" + rectWidth + ":" + rectHeight
          + ":force_original_aspect_ratio=decrease,pad=" + rectWidth
          + ":" + rectHeight + ":(ow-iw)/2:(oh-ih)/2:color=black,"
          + "setsar=1,format=yuv420p[" + name + "]");
        graph.push("[" + videoOut + "][" + name + "]overlay=x=" + x
          + ":y=" + y + ":shortest=0:eof_action=pass:repeatlast=0:"
          + "enable='between(t," + layer.at.toFixed(3) + ","
          + (layer.at + length).toFixed(3) + ")'[" + next + "]");
        videoOut = next;
      });
    }
    let audioOut = "0:a:0";
    if (audioLayers.length) {
      graph.push("[0:a:0]aresample=48000,aformat=channel_layouts=stereo,"
        + "asetpts=PTS-STARTPTS[abase]");
      const refs = ["[abase]"];
      audioLayers.forEach(({index, layer, length}, number) => {
        const name = "aud" + number;
        const delay = Math.round(layer.at * 1000);
        graph.push("[" + index + ":a:0]aresample=48000,"
          + "aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,"
          + "volume=" + (layer.volume ?? 1).toFixed(3)
          + ",atrim=duration=" + length.toFixed(3)
          + ",adelay=" + delay + ":all=1[" + name + "]");
        refs.push("[" + name + "]");
      });
      graph.push(refs.join("") + "amix=inputs=" + refs.length
        + ":duration=first:normalize=0:dropout_transition=0,"
        + "alimiter=limit=0.95[mixed]");
      audioOut = "mixed";
    }
    const args = [...input];
    if (graph.length) args.push("-filter_complex", graph.join(";"));
    args.push("-map", videoLayers.length ? "[" + videoOut + "]" : "0:v:0",
      "-map", audioLayers.length ? "[" + audioOut + "]" : "0:a:0");
    if (videoLayers.length) {
      args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
        "-pix_fmt", "yuv420p");
    } else args.push("-c:v", "copy");
    if (audioLayers.length) args.push("-c:a", "aac", "-b:a", "160k");
    else args.push("-c:a", "copy");
    args.push("-t", duration.toFixed(3), "-movflags", "+faststart", output);
    return args;
  }
}

export const createBrowserAPI = () => new BrowserAPI();
