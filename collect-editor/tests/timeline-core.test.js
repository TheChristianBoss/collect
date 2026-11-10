"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../static/timeline-core.js");

const sample = () => [
  {clip_id: "a", start: 0, end: 10},
  {clip_id: "b", start: 2, end: 8},
  {clip_id: "c", start: 0, end: 3}
];

test("split keeps both trims and total duration", () => {
  const original = sample();
  const result = T.split(original, 0, 4);
  assert.ok(result);
  assert.equal(result.index, 1);
  assert.deepEqual(result.items.slice(0, 2), [
    {clip_id: "a", start: 0, end: 4},
    {clip_id: "a", start: 4, end: 10}
  ]);
  assert.equal(T.total(result.items), T.total(original));
  assert.equal(original[0].end, 10, "must not mutate the original timeline");
});

test("split rejects edges shorter than 0.1 seconds", () => {
  assert.equal(T.split(sample(), 0, 0.05), null);
  assert.equal(T.split(sample(), 0, 9.95), null);
  assert.equal(T.split(sample(), -1, 2), null);
  assert.equal(T.split(sample(), 0, NaN), null);
});

test("reorder moves the first clip to the end", () => {
  const result = T.reorder(sample(), 0, 3);
  assert.equal(result.index, 2);
  assert.deepEqual(result.items.map((item) => item.clip_id), ["b", "c", "a"]);
});

test("reorder moves the last clip to the front", () => {
  const result = T.reorder(sample(), 2, 0);
  assert.equal(result.index, 0);
  assert.deepEqual(result.items.map((item) => item.clip_id), ["c", "a", "b"]);
});

test("reorder keeps the source untouched and validates indices", () => {
  const source = sample();
  assert.equal(T.reorder(source, -1, 2), null);
  assert.equal(T.reorder(source, 0, 5), null);
  T.reorder(source, 0, 3);
  assert.deepEqual(source.map((item) => item.clip_id), ["a", "b", "c"]);
});

test("project-time seek maps to correct clip and source time", () => {
  const point = T.locate(sample(), 11);
  assert.deepEqual(point, {index: 1, sourceTime: 3, offset: 10});
  assert.equal(T.projectTime(sample(), 1, 5), 13);
});

test("project seek handles boundaries and an empty project", () => {
  assert.equal(T.locate([], 0), null);
  assert.deepEqual(T.locate(sample(), 0), {index: 0, sourceTime: 0, offset: 0});
  assert.deepEqual(T.locate(sample(), 10), {index: 1, sourceTime: 2, offset: 10});
  assert.deepEqual(T.locate(sample(), 999), {index: 2, sourceTime: 3, offset: 16});
});
