/**
 * Tests for src/skins/skins.js and the HUD skin panel's pure helpers
 * (src/ui/skins-panel.js).
 *
 * These tests run headless under `node --test` — they never import three.js
 * or touch the DOM. Ghost fades / live voxel rendering live in
 * src/scene/scene.js (browser-only) and are covered by manual verification.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SKIN_ID,
  SKINS,
  getSkin,
  getSkins,
  registerSkin,
  SKIN_STYLES,
} from "../skins/skins.js";
import { isSkin, validateSkin } from "../contracts/skin.js";
import * as panel from "../ui/skins-panel.js";

/** Age (in ticks) → rgb stops used by the renderer's age tinting. */
function ageStops(ticks) {
  if (ticks <= 0) return [0.95, 0.38, 0.0];
  const t = Math.min(1, Math.max(0, ticks / 60));
  if (t < 0.25) return [t / 0.25, 0.0, 0.0];
  const mid = t < 0.6 ? (t - 0.25) / 0.35 : 1.0;
  return [0.85, mid, 1.0];
}

test("skins: registry defines at least three distinct skins", () => {
  assert.ok(SKINS.length >= 3, `expected >= 3 skins, got ${SKINS.length}`);
  const ids = SKINS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "skin ids must be unique");
});

test("skins: every skin satisfies the phase-1 contract from src/contracts", () => {
  for (const skin of SKINS) {
    validateSkin(skin); // must not throw
    assert.equal(isSkin(skin), true, `${skin.id} must satisfy contracts/validateSkin`);
    assert.equal(typeof skin.description, "string");
  }
});

test("skins: default id resolves and styles are supported", () => {
  assert.ok(SKIN_STYLES.includes("voxel"));
  assert.ok(SKIN_STYLES.includes("wireframe"));
  assert.ok(SKIN_STYLES.includes("organic"));
  const def = getSkin(DEFAULT_SKIN_ID);
  assert.ok(def, "default skin must be registered");
  assert.equal(def.style, "wireframe");
});

test("skins: registerSkin rejects duplicates and invalid entries", () => {
  assert.throws(() => registerSkin({ ...getSkin("classic-voxels") }), /already registered/);
  assert.throws(
    () => registerSkin({ id: "bad", label: "B", description: "d", color: 7, emissive: "x", background: "y" }),
    /color/,
  );
});

test("skins: each registry entry carries a distinct visual language", () => {
  const leaves = SKINS.map((s) => JSON.stringify({ style: s.style, palette: s.palette, fog: s.fog, grid: s.grid }));
  assert.equal(new Set(leaves).size, SKINS.length, "every skin must differ in style/palette/fog/grid");
});

test("skins: age tinting produces distinct colors for young, mid and old cells", () => {
  const young = ageStops(0);
  const mid = ageStops(30);
  const old = ageStops(120);
  assert.notDeepEqual(young, mid, "young and mid age colors must differ");
  assert.notDeepEqual(mid, old, "mid and old age colors must differ");
  for (const stop of [young, mid, old]) {
    assert.ok(stop.every((v) => v >= 0 && v <= 1), "rgb stops must be in [0,1]");
  }
  // Recent births are warm; old cells cool toward the palette end.
  assert.ok(young[2] < mid[2], "young cells should be redder (lower blue) than mid cells");
});

test("skins: dying palette is present and distinct from the live palette", () => {
  for (const skin of SKINS) {
    assert.ok(skin.palette.dying, `${skin.id} must define a dying color`);
    assert.notEqual(skin.palette.dying.toLowerCase(), skin.palette.mid.toLowerCase());
  }
});

test("skins: panel storage helpers are pure and failure-safe (no DOM)", () => {
  assert.equal(typeof panel.STORAGE_KEY, "string");
  assert.equal(panel.STORAGE_KEY.length > 0, true);
  assert.equal(panel.MAX_SKIN_OPTIONS >= 3, true);
  assert.equal(panel.DYING_FADE_MS > 0, true);
});

test("skins: panel helpers tolerate missing localStorage (SSR-safe)", () => {
  // In node --test there is no window.localStorage; the helpers must not throw
  // and must return safe defaults.
  try {
    const id = panel.readStoredSkinId();
    assert.equal(id, null);
  } catch (err) {
    assert.fail(`readStoredSkinId should not throw in non-browser env: ${err}`);
  }
  try {
    const ok = panel.writeStoredSkinId("classic-voxels");
    assert.equal(ok, false);
  } catch (err) {
    assert.fail(`writeStoredSkinId should not throw in non-browser env: ${err}`);
  }
});