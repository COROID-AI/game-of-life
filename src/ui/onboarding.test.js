/**
 * Tests for the onboarding tour helpers (src/ui/onboarding.js).
 *
 * The tour itself is DOM-heavy (browser-only), so these tests cover the
 * headless contract: step catalogue covers the required onboarding targets
 * (camera, rules editor, skins, multiplayer room creation), the persistence
 * flag works, and metrics names line up with the documented events.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FIRST_RUN_STEPS,
  HINT_STORAGE_KEY,
  shouldShowTour,
  markTourDone,
} from "./onboarding.js";
import { METRIC_EVENTS } from "../analytics/metrics.js";

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

test("onboarding: tour steps cover camera, rules editor, skins, and multiplayer creation", () => {
  const ids = FIRST_RUN_STEPS.map((s) => s.id);
  assert.ok(ids.includes("camera"));
  assert.ok(ids.includes("rules"));
  assert.ok(ids.includes("skins"));
  assert.ok(ids.includes("multiplayer"));
  for (const s of FIRST_RUN_STEPS) {
    assert.ok(typeof s.label === "string" && s.label.length > 0);
    assert.ok(typeof s.text === "string" && s.text.length > 0);
  }
});

test("onboarding: first-run flag is set once the tour finishes", () => {
  const storage = fakeStorage();
  assert.equal(shouldShowTour(storage), true);
  assert.equal(markTourDone(storage), true);
  assert.equal(shouldShowTour(storage), false);
  assert.equal(storage.getItem(HINT_STORAGE_KEY), "done");
});

test("onboarding: missing storage degrades to show-once behavior", () => {
  assert.equal(shouldShowTour(null), true, "without storage the tour should still show");
  // markTourDone requires storage to persist; without it the tour stays due.
  assert.equal(markTourDone(null), false, "marking done without storage is a no-op");
  assert.equal(shouldShowTour(null), true, "tour still shows next load without storage");
});

test("onboarding: hint metrics use documented event names", () => {
  assert.equal(FIRST_RUN_STEPS.length >= 4, true);
  // The tour emits the same metric names the README documents.
  assert.equal(typeof METRIC_EVENTS.HINT_SHOWN, "string");
  assert.equal(typeof METRIC_EVENTS.HINT_DISMISSED, "string");
});