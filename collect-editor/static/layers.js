"use strict";

/* Collect Editor v0.3: timed V2 picture-in-picture and A1/A2 audio layers.
 * V1 is managed by app.js. This module owns supplementary track clips.
 */
(function (root) {
  const app = root.CollectApp;
  const $ = (id) => document.getElementById(id);
  const TRACKS = ["V2", "A1", "A2"];
  const MAX_LAYERS = 100;
  const ROUND = (value) => Math.round(value * 1000) / 1000;
  let items = [];
  let selectedId = null;
  let initialized = false;
  let playingAudio = new Map();
  let videoLoadedFor = null;

  function mediaFor(item) {
    return app.getLibrary().find((media) => media.id === item.clip_id);
  }
  function length(item) { return Math.max(0, item.end - item.start); }
  function clone() { return items.map((item) => ({...item})); }
  function getSelected() { return items.find((item) => item.id === selectedId) || null; }
  function isValidMedia(media, track) {
    if (!media) return false;
    if (track === "V2") return media.kind !== "audio";
    return Boolean(media.has_audio);
  }
  function placementLimit() { return Math.max(0, app.getDuration() - 0.1); }
  function withinProject(time) { return Math.min(placementLimit(), Math.max(0, time)); }
  function newId() {
    return root.crypto?.randomUUID?.() || ("layer-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  }
  function getSave() { return clone(); }
  function loadFromSaved(saved) {
    items = Array.isArray(saved) ? saved.slice(0, MAX_LAYERS).filter((item) => {
      const media = item && mediaFor(item);
      return media && TRACKS.includes(item.track) && typeof item.id === "string"
        && isValidMedia(media, item.track)
        && Number.isFinite(item.at) && item.at >= 0
        && Number.isFinite(item.start) && Number.isFinite(item.end)
        && item.start >= 0 && item.end <= media.duration + 0.05
        && item.end - item.start >= 0.1
        && Number.isFinite(item.volume) && item.volume >= 0 && item.volume <= 2;
    }).map((item) => ({
      id: item.id, clip_id: item.clip_id, track: item.track,
      at: item.at, start: item.start, end: item.end, volume: item.volume
    })) : [];
    selectedId = null;
    render();
  }
  function snapshot() { return {items: clone(), selectedId}; }
  function restore(value) {
    items = Array.isArray(value?.items) ? value.items.map((x) => ({...x})) : [];
    selectedId = value?.selectedId || null;
    render();
    syncPreview();
  }
  function clearSelection() {
    if (!selectedId) return;
    selectedId = null;
    render();
  }
  function choose(id) {
    selectedId = id;
    app.renderInspector();
    render();
  }
  function addMedia(media, track) {
    if (!TRACKS.includes(track)) return;
    if (items.length >= MAX_LAYERS) { app.toast("Maximum 100 extra layer clips."); return; }
    if (!isValidMedia(media, track)) {
      app.toast(track === "V2" ? "V2 overlays require a video." : "Music and effects tracks require media with audio.");
      return;
    }
    app.remember();
    const at = withinProject(app.getPosition());
    const item = {
      id: newId(), clip_id: media.id, track,
      start: 0, end: media.duration, at, volume: 1
    };
    items.push(item);
    selectedId = item.id;
    app.renderTimeline();
    app.toast(media.name + " added to " + track);
  }
  function clearAudioPreview() {
    for (const player of playingAudio.values()) {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    playingAudio.clear();
  }
  function syncPreview() {
    const video = $("preview");
    const overlay = $("overlayPreview");
    if (!video || !overlay) return;
    const playing = !video.paused && app.getSelected() >= 0;
    const position = app.getPosition();
    const active = items.filter((item) =>
      position >= item.at && position < item.at + length(item)
      && position < app.getDuration()
    );
    // The most recently added V2 overlay is on top, as in FFmpeg rendering.
    const topVideo = active.filter((item) => item.track === "V2").at(-1);
    if (!topVideo) {
      overlay.pause();
      overlay.hidden = true;
      if (videoLoadedFor) {
        overlay.removeAttribute("src");
        overlay.load();
        videoLoadedFor = null;
      }
    } else {
      const media = mediaFor(topVideo);
      if (media) {
        const sourceTime = topVideo.start + position - topVideo.at;
        overlay.hidden = false;
        if (videoLoadedFor !== media.id) {
          videoLoadedFor = media.id;
          overlay.src = "/api/media/" + encodeURIComponent(media.id);
          overlay.onloadedmetadata = () => syncPreview();
          overlay.load();
        } else if (overlay.readyState >= 1) {
          if (Math.abs(overlay.currentTime - sourceTime) > 0.35) {
            overlay.currentTime = Math.max(0, Math.min(sourceTime, overlay.duration || sourceTime));
          }
          if (playing && overlay.paused) overlay.play().catch(() => {});
          if (!playing && !overlay.paused) overlay.pause();
        }
      }
    }
    const activeAudio = active.filter((item) => item.track === "A1" || item.track === "A2");
    const wanted = new Set(activeAudio.map((item) => item.id));
    for (const [id, player] of playingAudio) {
      if (!wanted.has(id)) {
        player.pause();
        player.removeAttribute("src");
        player.load();
        playingAudio.delete(id);
      }
    }
    activeAudio.forEach((item) => {
      const media = mediaFor(item);
      if (!media) return;
      let player = playingAudio.get(item.id);
      if (!player) {
        player = new Audio("/api/media/" + encodeURIComponent(media.id));
        player.preload = "auto";
        playingAudio.set(item.id, player);
      }
      player.volume = Math.max(0, Math.min(1, item.volume));
      const sourceTime = item.start + position - item.at;
      if (player.readyState >= 1 && Math.abs(player.currentTime - sourceTime) > 0.35) {
        player.currentTime = Math.max(0, Math.min(sourceTime, player.duration || sourceTime));
      }
      if (playing && player.paused) player.play().catch(() => {});
      if (!playing && !player.paused) player.pause();
    });
  }
  function render() {
    TRACKS.forEach((track) => {
      const lane = $("layerTrack" + track);
      if (!lane) return;
      const previousScroll = lane.scrollLeft;
      lane.replaceChildren();
      const canvas = document.createElement("div");
      canvas.className = "layer-canvas";
      const furthest = Math.max(app.getDuration(), ...items.filter((x) => x.track === track).map((x) => x.at + length(x)), 0);
      canvas.style.width = Math.max(lane.clientWidth || 400, 20 + furthest * app.getZoom()) + "px";
      items.filter((item) => item.track === track).forEach((item) => {
        const media = mediaFor(item);
        const chip = document.createElement("button");
        chip.className = "layer-clip layer-" + track.toLowerCase()
          + (item.id === selectedId ? " selected" : "");
        chip.type = "button";
        chip.style.left = item.at * app.getZoom() + "px";
        chip.style.width = Math.max(36, length(item) * app.getZoom()) + "px";
        chip.title = (media?.name || "Missing media") + " — start "
          + app.fmt(item.at) + ", duration " + app.fmt(length(item));
        const title = document.createElement("strong");
        title.textContent = media?.name || "Missing media";
        const time = document.createElement("small");
        time.textContent = app.fmt(item.at) + " · " + app.fmt(length(item));
        chip.append(title, time);
        let pointer = null;
        chip.onpointerdown = (event) => {
          if (event.button !== 0) return;
          pointer = {id: event.pointerId, x: event.clientX,
                     origin: item.at, proposed: item.at, moving: false};
          chip.setPointerCapture(event.pointerId);
        };
        chip.onpointermove = (event) => {
          if (!pointer || pointer.id !== event.pointerId) return;
          const delta = event.clientX - pointer.x;
          if (Math.abs(delta) > 5) pointer.moving = true;
          if (pointer.moving) {
            pointer.proposed = ROUND(Math.max(0, pointer.origin + delta / app.getZoom()));
            chip.style.left = pointer.proposed * app.getZoom() + "px";
          }
        };
        chip.onpointerup = (event) => {
          if (!pointer || pointer.id !== event.pointerId) return;
          const moved = pointer.moving && Math.abs(pointer.proposed - item.at) > 0.001;
          if (moved) {
            app.remember();
            item.at = pointer.proposed;
            selectedId = item.id;
            app.renderTimeline();
          } else choose(item.id);
          pointer = null;
        };
        chip.onpointercancel = () => { pointer = null; render(); };
        chip.onkeydown = (event) => {
          if (event.key === "Enter") choose(item.id);
        };
        canvas.append(chip);
      });
      lane.append(canvas);
      lane.scrollLeft = previousScroll;
    });
    renderInspector();
  }
  function renderInspector() {
    const selected = getSelected();
    const block = $("layerInspector");
    if (!block) return;
    block.hidden = !selected;
    if (!selected) return;
    $("inspectorFields").hidden = true;
    $("inspectorEmpty").hidden = true;
    const media = mediaFor(selected);
    $("layerClipName").textContent = media?.name || "Missing media";
    $("layerTrackPicker").value = selected.track;
    $("layerAt").value = selected.at.toFixed(2);
    $("layerStart").value = selected.start.toFixed(2);
    $("layerEnd").value = selected.end.toFixed(2);
    $("layerVolumeWrapper").hidden = selected.track === "V2";
    $("layerVolume").value = String(Math.round(selected.volume * 100));
    $("layerDuration").textContent = app.fmt(length(selected));
  }
  function changeLayer() {
    const item = getSelected();
    if (!item) return;
    const media = mediaFor(item);
    const track = $("layerTrackPicker").value;
    const at = Number($("layerAt").value);
    const start = Number($("layerStart").value);
    const end = Number($("layerEnd").value);
    const volume = Number($("layerVolume").value) / 100;
    if (!TRACKS.includes(track) || !isValidMedia(media, track)) {
      app.toast("Selected media is not compatible with this track."); renderInspector(); return;
    }
    if (![at, start, end, volume].every(Number.isFinite)
        || at < 0 || start < 0 || end - start < 0.1
        || end > media.duration + 0.05 || volume < 0 || volume > 2) {
      app.toast("Enter valid layer position, trim and volume values."); renderInspector(); return;
    }
    if (item.track === track && item.at === at && item.start === start
        && item.end === end && item.volume === volume) return;
    app.remember();
    Object.assign(item, {track, at, start, end: Math.min(end, media.duration), volume});
    app.renderTimeline();
    syncPreview();
  }
  function shift(seconds) {
    const item = getSelected();
    if (!item) return;
    const at = ROUND(Math.max(0, item.at + seconds));
    if (at === item.at) return;
    app.remember();
    item.at = at;
    app.renderTimeline();
    syncPreview();
  }
  function remove() {
    if (!getSelected()) return;
    app.remember();
    items = items.filter((item) => item.id !== selectedId);
    selectedId = null;
    app.renderInspector();
    app.renderTimeline();
    syncPreview();
  }
  function exportLayers() {
    return items.filter((item) => item.at < app.getDuration()).map((item) => ({
      clip_id: item.clip_id,
      track: item.track,
      start: item.start,
      end: item.end,
      at: item.at,
      volume: item.volume
    }));
  }
  function init() {
    if (initialized) return;
    initialized = true;
    ["layerAt", "layerStart", "layerEnd", "layerVolume", "layerTrackPicker"].forEach((id) => {
      $(id).onchange = changeLayer;
    });
    $("layerBack").onclick = () => shift(-1);
    $("layerForward").onclick = () => shift(1);
    $("removeLayer").onclick = remove;
    window.addEventListener("beforeunload", clearAudioPreview);
  }
  root.CollectLayers = {
    init, addMedia, getSave, loadFromSaved, snapshot, restore,
    clearSelection, render, renderInspector, exportLayers, syncPreview
  };
})(globalThis);
