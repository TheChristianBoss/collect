"use strict";

const $ = (id) => document.getElementById(id);
const T = globalThis.CollectTimeline;
const PROJECT_KEY = "collect-editor.timeline.v2";
const ZOOM_KEY = "collect-editor.timeline.zoom.v2";
let library = [];
let timeline = [];
let selected = -1;
let zoom = 16;
let exportTimer = null;
let toastTimer = null;
let dragFrom = -1;
let loaded = false;
let sourceGeneration = 0;
const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 50;
const MAX_CLIPS = 100;

function fmt(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(n / 60);
  return String(minutes).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
}
function current() { return timeline[selected] || null; }
function mediaFor(item) { return library.find((media) => media.id === item.clip_id); }
function total() { return T.total(timeline); }
function duration(item) { return T.duration(item); }
function projectPosition() {
  const item = current();
  if (!item) return 0;
  const videoTime = Number.isFinite($("preview").currentTime) ? $("preview").currentTime : item.start;
  return T.projectTime(timeline, selected, videoTime);
}
function toast(message) {
  const notice = $("toast");
  notice.textContent = message;
  notice.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => notice.classList.remove("visible"), 4500);
}
async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let details = {};
    try { details = await response.json(); } catch {}
    throw Error(typeof details.detail === "string" ? details.detail : "Request failed: " + response.status);
  }
  return response.json();
}
function persist() {
  if (!loaded) return;
  try {
    localStorage.setItem(PROJECT_KEY, JSON.stringify({
      items: timeline, layers: globalThis.CollectLayers?.getSave?.() || []
    }));
  } catch {
    // Private browsing/storage restrictions must not prevent editing.
  }
}
function restoreProject() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PROJECT_KEY) || "null"); } catch {}
  if (saved && Array.isArray(saved.items)) {
    timeline = saved.items.slice(0, MAX_CLIPS).filter((item) => {
      if (!item || typeof item.clip_id !== "string") return false;
      const media = mediaFor(item);
      return media && Number.isFinite(item.start) && Number.isFinite(item.end)
        && item.start >= 0 && item.end - item.start >= T.MIN_CLIP
        && item.end <= media.duration + 0.05;
    }).map((item) => ({
      clip_id: item.clip_id, start: item.start, end: item.end,
      transition: item.transition === "fade" ? "fade" : "cut",
      fade_seconds: Number.isFinite(item.fade_seconds)
        ? Math.max(0.1, Math.min(1.5, item.fade_seconds)) : 0.45
    }));
  }
  try {
    const value = Number(localStorage.getItem(ZOOM_KEY));
    if (Number.isFinite(value) && value >= 6 && value <= 80) zoom = value;
  } catch {}
  globalThis.CollectLayers?.loadFromSaved?.(saved?.layers || []);
  $("timelineZoom").value = String(zoom);
}
function snapshot() {
  return {
    items: T.copy(timeline),
    selected,
    sourceTime: current() ? $("preview").currentTime : 0,
    layerSnapshot: globalThis.CollectLayers?.snapshot?.() || null
  };
}
function remember() {
  undoStack.push(snapshot());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}
function restore(snapshotValue) {
  timeline = T.copy(snapshotValue.items);
  const index = Math.min(snapshotValue.selected, timeline.length - 1);
  select(index, false, snapshotValue.sourceTime);
  globalThis.CollectLayers?.restore?.(snapshotValue.layerSnapshot);
  renderTimeline();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}
function canAdd() {
  if (timeline.length >= MAX_CLIPS) {
    toast("A project can currently contain up to 100 timeline clips.");
    return false;
  }
  return true;
}
function renderLibrary() {
  $("mediaCount").textContent = String(library.length);
  const list = $("mediaList");
  list.replaceChildren();
  if (!library.length) {
    const empty = document.createElement("div");
    empty.className = "empty-library";
    empty.textContent = "Your imported clips will appear here.";
    list.append(empty);
    return;
  }
  library.forEach((media) => {
    const row = document.createElement("div");
    row.className = "media-item";
    const thumbnail = document.createElement("div");
    thumbnail.className = "media-thumb";
    thumbnail.textContent = media.kind === "audio" ? "♫" : "▶";
    const details = document.createElement("div");
    details.className = "media-details";
    const label = document.createElement("strong");
    label.textContent = media.name;
    label.title = media.name;
    const secondary = document.createElement("span");
    secondary.textContent = fmt(media.duration) + " · " + (media.bytes / 1048576).toFixed(1) + " MB";
    details.append(label, secondary);
    const add = document.createElement("button");
    add.className = "add-button";
    add.textContent = "+";
    add.title = "Add to timeline";
    add.setAttribute("aria-label", "Add " + media.name + " to timeline");
    add.onclick = () => {
      const target = $("targetTrack").value;
      if (target !== "V1") {
        globalThis.CollectLayers?.addMedia?.(media, target);
        return;
      }
      if (media.kind === "audio") {
        toast("Audio-only media belongs on A1 or A2.");
        return;
      }
      if (!canAdd()) return;
      remember();
      timeline.push({
        clip_id: media.id, start: 0, end: media.duration,
        transition: "cut", fade_seconds: 0.45
      });
      select(timeline.length - 1);
      toast("Clip added to timeline");
    };
    row.append(thumbnail, details, add);
    list.append(row);
  });
}
function clearDragClasses() {
  document.querySelectorAll(".timeline-clip").forEach((element) => {
    element.classList.remove("drop-before", "drop-after", "dragging");
  });
}
function renderTimeline() {
  const track = $("timelineTrack");
  const scroll = track.scrollLeft;
  $("timelineCount").textContent = timeline.length + (timeline.length === 1 ? " clip" : " clips");
  $("projectDuration").textContent = "Total " + fmt(total());
  $("rulerEnd").textContent = fmt(total());
  $("projectLengthText").textContent = fmt(total());
  track.replaceChildren();
  if (!timeline.length) {
    const empty = document.createElement("div");
    empty.className = "timeline-placeholder";
    empty.textContent = "Your timeline is empty. Add a clip from the media library to begin.";
    track.append(empty);
  }
  timeline.forEach((item, index) => {
    const media = mediaFor(item);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "timeline-clip" + (index === selected ? " selected" : "");
    button.style.width = Math.max(1, duration(item) * zoom) + "px";
    button.title = (media ? media.name : "Missing media") + " — " + fmt(duration(item)) + ". Drag to reorder.";
    button.draggable = true;
    button.dataset.index = String(index);
    const label = document.createElement("span");
    label.className = "title";
    label.textContent = media ? media.name : "Missing media";
    if (index > 0 && item.transition === "fade") label.textContent = "◐ " + label.textContent;
    const time = document.createElement("span");
    time.className = "duration";
    time.textContent = fmt(duration(item));
    const number = document.createElement("span");
    number.className = "clip-index";
    number.textContent = String(index + 1).padStart(2, "0");
    button.append(label, time, number);
    button.onclick = (event) => {
      globalThis.CollectLayers?.clearSelection?.();
      const bounds = button.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      select(index, false, item.start + duration(item) * ratio);
    };
    button.ondragstart = (event) => {
      dragFrom = index;
      button.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    };
    button.ondragover = (event) => {
      if (dragFrom === -1) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      button.classList.toggle("drop-before", event.clientX < button.getBoundingClientRect().left + button.offsetWidth / 2);
      button.classList.toggle("drop-after", !button.classList.contains("drop-before"));
    };
    button.ondragleave = () => button.classList.remove("drop-before", "drop-after");
    button.ondrop = (event) => {
      event.preventDefault();
      if (dragFrom < 0) return;
      const midpoint = button.getBoundingClientRect().left + button.offsetWidth / 2;
      const slot = index + (event.clientX >= midpoint ? 1 : 0);
      const result = T.reorder(timeline, dragFrom, slot);
      clearDragClasses();
      dragFrom = -1;
      if (!result) return;
      // A drop into the source's existing slot is a no-op.
      if (result.items.every((x, i) => x.clip_id === timeline[i].clip_id
        && x.start === timeline[i].start && x.end === timeline[i].end)) return;
      remember();
      timeline = result.items;
      select(result.index);
      toast("Clip reordered");
    };
    button.ondragend = () => { dragFrom = -1; clearDragClasses(); };
    track.append(button);
  });
  if (timeline.length) {
    const line = document.createElement("div");
    line.className = "timeline-playhead";
    line.id = "timelinePlayhead";
    line.setAttribute("aria-hidden", "true");
    track.append(line);
  }
  track.scrollLeft = scroll;
  const active = selected >= 0 && selected < timeline.length;
  $("previousButton").disabled = !active || selected === 0;
  $("nextButton").disabled = !active || selected === timeline.length - 1;
  $("clearTimeline").disabled = !timeline.length;
  $("exportButton").disabled = !timeline.length;
  $("splitClip").disabled = !active || timeline.length >= MAX_CLIPS;
  $("duplicateClip").disabled = !active || timeline.length >= MAX_CLIPS;
  $("undoEdit").disabled = undoStack.length === 0;
  $("redoEdit").disabled = redoStack.length === 0;
  updateProjectCursor();
  globalThis.CollectLayers?.render?.();
  persist();
}
function updateProjectCursor() {
  const seconds = projectPosition();
  $("projectCursorText").textContent = fmt(seconds);
  $("projectSeekBar").disabled = !timeline.length;
  $("projectSeekBar").value = total() > 0 ? Math.round(1000 * seconds / total()) : 0;
  const line = $("timelinePlayhead");
  const button = document.querySelector(".timeline-clip.selected");
  const item = current();
  if (line && button && item) {
    const sourceTime = Number.isFinite($("preview").currentTime) ? $("preview").currentTime : item.start;
    const ratio = Math.max(0, Math.min(1, (sourceTime - item.start) / Math.max(duration(item), 0.001)));
    line.style.left = (button.offsetLeft + button.offsetWidth * ratio) + "px";
  }
}
function renderInspector() {
  const item = current();
  $("inspectorEmpty").hidden = !!item;
  $("inspectorFields").hidden = !item;
  if (!item) return;
  const media = mediaFor(item);
  $("inspectorName").textContent = media ? media.name : "Missing media";
  $("originalDuration").textContent = fmt(media ? media.duration : 0);
  $("trimStart").value = item.start.toFixed(2);
  $("trimEnd").value = item.end.toFixed(2);
  $("selectedDuration").textContent = fmt(duration(item));
  $("moveLeft").disabled = selected <= 0;
  $("moveRight").disabled = selected >= timeline.length - 1;
  $("transitionInspector").hidden = selected === 0;
  $("transitionType").value = item.transition === "fade" ? "fade" : "cut";
  $("transitionDuration").value = (item.fade_seconds || 0.45).toFixed(2);
  $("transitionDuration").disabled = selected === 0 || item.transition !== "fade";
}
function renderTransport() {
  const item = current();
  const video = $("preview");
  if (!item) {
    $("timeDisplay").textContent = "00:00 / 00:00";
    $("seekBar").value = "0";
    $("playButton").textContent = "▶";
    updateProjectCursor();
    return;
  }
  const time = Math.max(item.start, Math.min(item.end, video.currentTime || item.start));
  $("timeDisplay").textContent = fmt(time - item.start) + " / " + fmt(duration(item));
  $("seekBar").value = String(Math.round(1000 * (time - item.start) / Math.max(0.1, duration(item))));
  $("playButton").textContent = video.paused ? "▶" : "Ⅱ";
  let brightness = 1;
  if (selected > 0 && item.transition === "fade") {
    const length = Math.min(item.fade_seconds || 0.45, duration(item) * 0.45);
    brightness = Math.min(brightness, Math.max(0, (time - item.start) / Math.max(0.01, length)));
  }
  if (selected + 1 < timeline.length && timeline[selected + 1].transition === "fade") {
    const length = Math.min(timeline[selected + 1].fade_seconds || 0.45, duration(item) * 0.45);
    brightness = Math.min(brightness, Math.max(0, (item.end - time) / Math.max(0.01, length)));
  }
  video.style.opacity = String(brightness);
  video.volume = brightness;
  updateProjectCursor();
  globalThis.CollectLayers?.syncPreview?.();
}
function select(index, autoplay = false, sourceTime = null) {
  selected = index >= 0 && index < timeline.length ? index : -1;
  const video = $("preview");
  video.pause();
  const generation = ++sourceGeneration;
  const item = current();
  if (!item) {
    delete video.dataset.clipId;
    video.removeAttribute("src");
    video.load();
    video.classList.remove("active");
    video.style.opacity = "1";
    video.volume = 1;
    $("viewerEmpty").hidden = false;
    $("previewTitle").textContent = "No clip selected";
  } else {
    const media = mediaFor(item);
    if (!media) { toast("This media file is no longer available."); return; }
    const wanted = Number.isFinite(sourceTime)
      ? Math.min(item.end, Math.max(item.start, sourceTime)) : item.start;
    const alreadyLoaded = video.dataset.clipId === media.id && video.readyState >= 1;
    video.classList.add("active");
    $("viewerEmpty").hidden = true;
    $("previewTitle").textContent = media.name;
    if (alreadyLoaded) {
      video.currentTime = wanted;
      if (autoplay) video.play().catch(() => toast("Press Play to continue."));
    } else {
      video.dataset.clipId = media.id;
      video.onloadedmetadata = () => {
        if (generation !== sourceGeneration) return;
        video.currentTime = wanted;
        if (autoplay) video.play().catch(() => toast("Press Play to continue."));
        renderTransport();
      };
      video.src = "/api/media/" + encodeURIComponent(media.id);
      video.load();
    }
  }
  renderInspector();
  renderTimeline();
  renderTransport();
}
function seekProject(seconds) {
  const point = T.locate(timeline, seconds);
  if (!point) return;
  select(point.index, false, point.sourceTime);
}
function trim() {
  const item = current();
  if (!item) return;
  const media = mediaFor(item);
  const start = Number($("trimStart").value);
  const end = Number($("trimEnd").value);
  if (!Number.isFinite(start) || !Number.isFinite(end)
    || start < 0 || end - start < T.MIN_CLIP || end > media.duration + 0.05) {
    toast("Trim range must fit the source clip and keep at least 0.1 seconds.");
    renderInspector();
    return;
  }
  if (start === item.start && end === item.end) return;
  remember();
  item.start = start;
  item.end = Math.min(end, media.duration);
  select(selected, false, Math.max(start, Math.min(end, $("preview").currentTime)));
}
function splitAtPlayhead() {
  const item = current();
  if (!item || !canAdd()) return;
  const result = T.split(timeline, selected, $("preview").currentTime);
  if (!result) {
    toast("Move the playhead at least 0.1 seconds away from either clip edge before splitting.");
    return;
  }
  remember();
  timeline = result.items;
  select(result.index, false, result.at);
  toast("Clip split at playhead");
}
function duplicate() {
  const item = current();
  if (!item || !canAdd()) return;
  remember();
  timeline.splice(selected + 1, 0, {...item});
  select(selected + 1);
  toast("Clip duplicated");
}
function removeSelected() {
  if (selected < 0) return;
  remember();
  timeline.splice(selected, 1);
  select(Math.min(selected, timeline.length - 1));
}
function shiftClip(direction) {
  if (selected < 0) return;
  const slot = direction < 0 ? selected - 1 : selected + 2;
  const result = T.reorder(timeline, selected, slot);
  if (!result || result.index === selected) return;
  remember();
  timeline = result.items;
  select(result.index);
}
function setZoom(value) {
  zoom = Math.max(6, Math.min(80, Math.round(value / 2) * 2));
  $("timelineZoom").value = String(zoom);
  try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch {}
  renderTimeline();
}
async function uploadFiles(files) {
  if (!files.length) return;
  $("uploadStatus").textContent = "Uploading " + files.length + " file(s)…";
  let completed = 0;
  for (const file of files) {
    try {
      const body = new FormData();
      body.append("file", file);
      library.push(await api("/api/clips", {method: "POST", body}));
      completed++;
      renderLibrary();
    } catch (error) {
      toast(file.name + ": " + error.message);
    }
  }
  $("uploadStatus").textContent = completed + " clip(s) imported";
  $("fileInput").value = "";
}
async function startExport() {
  const button = $("startExport");
  button.disabled = true;
  $("exportProgressArea").hidden = false;
  $("downloadExport").hidden = true;
  $("progressFill").style.width = "0%";
  try {
    const job = await api("/api/exports", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        segments: timeline.map((item) => ({
          clip_id: item.clip_id, start: item.start, end: item.end,
          transition: item.transition === "fade" ? "fade" : "cut",
          fade_seconds: item.fade_seconds || 0.45
        })),
        layers: globalThis.CollectLayers?.exportLayers?.() || [],
        resolution: $("resolution").value
      })
    });
    clearInterval(exportTimer);
    const poll = async () => {
      try {
        const status = await api("/api/exports/" + job.id);
        $("progressFill").style.width = status.progress + "%";
        $("exportMessage").textContent = status.message;
        if (status.status === "complete") {
          clearInterval(exportTimer);
          exportTimer = null;
          $("downloadExport").href = status.download_url;
          $("downloadExport").hidden = false;
          button.hidden = true;
          toast("Export complete!");
        } else if (status.status === "error") {
          clearInterval(exportTimer);
          exportTimer = null;
          button.disabled = false;
          toast(status.message);
        }
      } catch (error) {
        clearInterval(exportTimer);
        exportTimer = null;
        button.disabled = false;
        toast(error.message);
      }
    };
    await poll();
    if (exportTimer === null && !button.hidden && button.disabled) {
      exportTimer = setInterval(poll, 1000);
    }
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}
function togglePlay() {
  const item = current(), video = $("preview");
  if (!item) return;
  if (video.paused) {
    if (video.currentTime >= item.end - 0.05) video.currentTime = item.start;
    video.play().catch(() => toast("This file cannot be previewed in your browser."));
  } else video.pause();
}
function bindEvents() {
  $("fileInput").onchange = (event) => uploadFiles([...event.target.files]);
  const zone = $("dropZone");
  zone.ondragover = (event) => { event.preventDefault(); zone.classList.add("dragging"); };
  zone.ondragleave = () => zone.classList.remove("dragging");
  zone.ondrop = (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    uploadFiles([...event.dataTransfer.files]);
  };
  $("trimStart").onchange = trim;
  $("trimEnd").onchange = trim;
  const updateTransition = () => {
    const item = current();
    if (!item || selected === 0) return;
    const type = $("transitionType").value;
    const seconds = Number($("transitionDuration").value);
    if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 1.5) {
      toast("Fade duration must be between 0.1 and 1.5 seconds.");
      renderInspector();
      return;
    }
    if (item.transition === type && item.fade_seconds === seconds) return;
    remember();
    item.transition = type;
    item.fade_seconds = seconds;
    renderInspector();
    renderTimeline();
    renderTransport();
  };
  $("transitionType").onchange = updateTransition;
  $("transitionDuration").onchange = updateTransition;
  $("resetTrim").onclick = () => {
    const item = current();
    if (!item) return;
    if (item.start === 0 && item.end === mediaFor(item).duration) return;
    remember();
    item.start = 0;
    item.end = mediaFor(item).duration;
    select(selected);
  };
  $("moveLeft").onclick = () => shiftClip(-1);
  $("moveRight").onclick = () => shiftClip(1);
  $("removeTimeline").onclick = removeSelected;
  $("splitClip").onclick = splitAtPlayhead;
  $("duplicateClip").onclick = duplicate;
  $("undoEdit").onclick = undo;
  $("redoEdit").onclick = redo;
  $("clearTimeline").onclick = () => {
    if (!timeline.length || !confirm("Remove all clips from this timeline?")) return;
    remember();
    timeline = [];
    select(-1);
  };
  $("timelineZoom").oninput = (event) => setZoom(Number(event.target.value));
  $("zoomOut").onclick = () => setZoom(zoom - 4);
  $("zoomIn").onclick = () => setZoom(zoom + 4);
  $("projectSeekBar").oninput = (event) => seekProject(total() * Number(event.target.value) / 1000);
  $("previousButton").onclick = () => { if (selected > 0) select(selected - 1); };
  $("nextButton").onclick = () => { if (selected < timeline.length - 1) select(selected + 1); };
  $("playButton").onclick = togglePlay;
  const video = $("preview");
  video.ontimeupdate = () => {
    const item = current();
    if (!item) return;
    if (video.currentTime >= item.end - 0.03) {
      if (selected < timeline.length - 1 && !video.paused) select(selected + 1, true);
      else { video.pause(); renderTransport(); }
    } else renderTransport();
  };
  video.onpause = () => { renderTransport(); globalThis.CollectLayers?.syncPreview?.(); };
  video.onplay = () => { renderTransport(); globalThis.CollectLayers?.syncPreview?.(); };
  video.onerror = () => { if (current()) toast("Preview unsupported by this browser. Export may still work."); };
  $("seekBar").oninput = (event) => {
    const item = current();
    if (item) video.currentTime = item.start + duration(item) * Number(event.target.value) / 1000;
  };
  document.onkeydown = (event) => {
    if (event.repeat || $("exportDialog").open) return;
    const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
      || document.activeElement?.isContentEditable;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.code === "KeyZ") {
      if (editing) return;
      event.preventDefault();
      event.shiftKey ? redo() : undo();
      return;
    }
    if (modifier && event.code === "KeyY") {
      if (editing) return;
      event.preventDefault();
      redo();
      return;
    }
    if (editing) return;
    if (event.code === "Space" && document.activeElement?.tagName !== "BUTTON") {
      event.preventDefault(); togglePlay();
    }
    if (!modifier && event.code === "KeyS") { event.preventDefault(); splitAtPlayhead(); }
    if (!modifier && (event.code === "Delete" || event.code === "Backspace")) {
      event.preventDefault(); removeSelected();
    }
  };
  $("exportButton").onclick = () => {
    $("exportClips").textContent = timeline.length + " clips";
    $("exportDuration").textContent = fmt(total()) + " duration";
    $("exportProgressArea").hidden = true;
    $("downloadExport").hidden = true;
    $("startExport").hidden = false;
    $("startExport").disabled = false;
    $("exportDialog").showModal();
  };
  $("startExport").onclick = startExport;
  const linkedTracks = ["timelineTrack", "layerTrackV2", "layerTrackA1", "layerTrackA2"]
    .map((id) => $(id));
  let syncingScroll = false;
  linkedTracks.forEach((track) => {
    track.addEventListener("scroll", () => {
      if (syncingScroll) return;
      syncingScroll = true;
      linkedTracks.forEach((other) => {
        if (other !== track) other.scrollLeft = track.scrollLeft;
      });
      syncingScroll = false;
    });
  });
}
async function main() {
  if (!T) { toast("Timeline tools are missing. Reload the page."); return; }
  bindEvents();
  renderLibrary();
  renderTimeline();
  try {
    const health = await api("/api/health");
    if (!health.ffmpeg) toast("Install FFmpeg and FFprobe before exporting.");
    library = await api("/api/clips");
    globalThis.CollectLayers?.init?.();
    loaded = true;
    restoreProject();
    renderLibrary();
    if (timeline.length) select(0);
    else renderTimeline();
  } catch (error) {
    toast("Unable to load project: " + error.message);
  }
}
globalThis.CollectApp = {
  getLibrary: () => library,
  getTimeline: () => timeline,
  getSelected: () => selected,
  getZoom: () => zoom,
  getPosition: projectPosition,
  getDuration: total,
  getMedia: mediaFor,
  fmt, toast, remember, renderTimeline, renderInspector, persist, canAdd,
};
main();
