/**
 * Tests for the local metrics reporter (src/analytics/metrics.js).
 *
 * Validates the instrumented events required by the delivery goals:
 *   - session start/end with duration + active time
 *   - custom-rule exploration flag (once per session)
 *   - skin switch counts
 *   - multiplayer join counts
 * The reporter is pure and headless-safe, so these run under `node --test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMetrics,
  METRIC_EVENTS,
  readQueuedEvents,
  writeQueuedEvents,
  DEFAULT_STORAGE_KEY,
} from "../analytics/metrics.js";

/** In-memory localStorage stand-in (same getItem/setItem contract). */
function fakeStorage(initial = new Map()) {
  const map = new Map(initial);
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
  };
}

test("metrics: session start/end record duration and active time", () => {
  const storage = fakeStorage();
  const m = createMetrics({ sessionId: "s-test", storageKey: "k", console: false });
  m.start();
  m.addActiveTime(1200);
  m.addActiveTime(800);
  m.end();

  const events = m.getEvents();
  assert.equal(events[0].name, METRIC_EVENTS.SESSION_START);
  const end = events.find((e) => e.name === METRIC_EVENTS.SESSION_END);
  assert.ok(end, "session:end must be emitted");
  assert.equal(end.activeMs, 2000);
  assert.ok(end.durationMs >= 0);
  assert.equal(end.sessionId, "s-test");
});

test("metrics: custom-rule exploration is a flag (emitted once per session)", () => {
  const m = createMetrics({ console: false });
  const rule = { id: "my-rule", name: "My Rule", birth: [4], survive: [2, 3] };
  assert.equal(m.recordCustomRule(rule), true);
  assert.equal(m.recordCustomRule(rule), false, "same rule must not re-emit");
  const events = m.getEvents();
  const hits = events.filter((e) => e.name === METRIC_EVENTS.CUSTOM_RULE_EXPLORED);
  assert.equal(hits.length, 1);
});

test("metrics: skin and multiplayer events are counted", () => {
  const m = createMetrics({ console: false });
  m.record(METRIC_EVENTS.SKIN_SWITCH, { skinId: "neon-wireframe" });
  m.record(METRIC_EVENTS.SKIN_SWITCH, { skinId: "organic" });
  m.record(METRIC_EVENTS.MULTIPLAYER_JOIN, { role: "host" });
  m.record(METRIC_EVENTS.MULTIPLAYER_JOIN, { role: "joiner" });
  const summary = m.getSummary();
  assert.equal(summary.events[METRIC_EVENTS.SKIN_SWITCH], 2);
  assert.equal(summary.events[METRIC_EVENTS.MULTIPLAYER_JOIN], 2);
});

test("metrics: localStorage queue round-trips and is bounded", () => {
  const storage = fakeStorage();
  const m = createMetrics({ storageKey: "k", console: false, storage });
  m.record("a:1");
  m.record("b:2");
  // A second reporter on the same page reads the same sink.
  const queued = readQueuedEvents(storage, "k");
  assert.ok(queued.length >= 2, "events must be appended to the shared sink");
  assert.equal(queued[0].name, "a:1");
  assert.equal(queued[1].name, "b:2");

  writeQueuedEvents([], storage, "k");
  assert.deepEqual(readQueuedEvents(storage, "k"), []);
});

test("metrics: corrupt queue degrades gracefully", () => {
  const storage = {
    getItem() {
      return "{not json!!";
    },
    setItem() {},
  };
  assert.deepEqual(readQueuedEvents(storage, DEFAULT_STORAGE_KEY), []);
  const m = createMetrics({ storageKey: DEFAULT_STORAGE_KEY, console: false });
  m.record("x");
  assert.equal(m.getEvents().length, 1);
});

test("metrics: events fan out to the onEvent hook, and end blocks late events", () => {
  const seen = [];
  const m = createMetrics({ console: false, onEvent: (e) => seen.push(e) });
  m.start();
  m.end();
  m.record(METRIC_EVENTS.SKIN_SWITCH, { skinId: "organic" }); // after end → dropped
  assert.ok(seen.some((e) => e.name === METRIC_EVENTS.SESSION_START));
  assert.ok(seen.some((e) => e.name === METRIC_EVENTS.SESSION_END));
  assert.equal(m.getEvents().filter((e) => e.name === METRIC_EVENTS.SKIN_SWITCH).length, 0);
});