/* Timeline algorithms shared by browser UI and Node tests. */
(function (root, factory) {
  const tools = factory();
  if (typeof module === "object" && module.exports) module.exports = tools;
  root.CollectTimeline = tools;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const MIN_CLIP = 0.1;
  const round = (number) => Math.round(number * 1000) / 1000;
  const duration = (clip) => Math.max(0, clip.end - clip.start);
  const total = (items) => items.reduce((sum, item) => sum + duration(item), 0);
  const copy = (items) => items.map((item) => ({ ...item }));

  function split(items, index, sourceTime) {
    const item = items[index];
    if (!item || !Number.isFinite(sourceTime)) return null;
    const at = round(sourceTime);
    if (at - item.start < MIN_CLIP - 0.00001 || item.end - at < MIN_CLIP - 0.00001) {
      return null;
    }
    const updated = copy(items);
    updated.splice(index, 1, { ...item, end: at }, { ...item, start: at });
    return { items: updated, index: index + 1, at };
  }

  // "slot" is a boundary between clips (0 = before the first, length = after the last).
  function reorder(items, from, slot) {
    if (!Number.isInteger(from) || from < 0 || from >= items.length
      || !Number.isInteger(slot) || slot < 0 || slot > items.length) return null;
    const updated = copy(items);
    const [item] = updated.splice(from, 1);
    const index = Math.min(updated.length, Math.max(0, slot - (from < slot ? 1 : 0)));
    updated.splice(index, 0, item);
    return { items: updated, index };
  }

  function locate(items, seconds) {
    if (!items.length || !Number.isFinite(seconds)) return null;
    const target = Math.max(0, Math.min(seconds, total(items)));
    let offset = 0;
    for (let index = 0; index < items.length; index++) {
      const item = items[index], length = duration(item);
      if (target < offset + length || index === items.length - 1) {
        return { index, sourceTime: item.start + Math.max(0, Math.min(length, target - offset)), offset };
      }
      offset += length;
    }
    return null;
  }

  function projectTime(items, index, sourceTime) {
    const item = items[index];
    if (!item) return 0;
    const before = total(items.slice(0, index));
    return before + Math.max(0, Math.min(duration(item), sourceTime - item.start));
  }

  return { MIN_CLIP, duration, total, copy, split, reorder, locate, projectTime };
});
