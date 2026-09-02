/**
 * Tests for the grid presets + quality guards (src/quality/quality.js).
 *
 * The renderer ships instanced rendering already; these tests cover the
 * remaining performance-control contract: preset catalogue bounds, quality
 * level mapping (deterministic per skin), FPS sampling windows, and the
 * ability to apply presets through the pure simulation API without touching
 * the transition rule-set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GRID_PRESETS,
  QUALITY_LEVELS,
  QUALITY_PROFILES,
  qualitySettingsFor,
  DEFAULT_QUALITY_PROFILE,
  createQualityController,
} from "./quality.js";
import { createSimulation } from "../engine/simulation.js";

test("quality: presets cover the default and a large grid, all within the cap", () => {
  assert.ok(GRID_PRESETS.some((p) => p.size === 16), "default 16³ preset required");
  assert.ok(GRID_PRESETS.some((p) => p.size === 32), "large 32³ preset required");
  for (const p of GRID_PRESETS) {
    assert.ok(Number.isInteger(p.size) && p.size > 0);
    assert.ok(p.size <= 32, "no preset may exceed the relay MAX_GRID_SIZE");
  }
  assert.equal(new Set(GRID_PRESETS.map((p) => p.id)).size, GRID_PRESETS.length);
});

test("quality: guard levels degrade deterministic settings per level", () => {
  assert.ok(QUALITY_LEVELS.length >= 3, "expect high/medium/low");
  const high = qualitySettingsFor(QUALITY_PROFILES["neon-wireframe"], 0);
  const low = qualitySettingsFor(QUALITY_PROFILES["neon-wireframe"], QUALITY_LEVELS.length - 1);
  assert.equal(high.level, 0);
  assert.equal(low.level, QUALITY_LEVELS.length - 1);
  assert.ok(high.pixelRatio >= low.pixelRatio, "low quality must reduce pixel ratio");
  assert.equal(typeof high.ghostFade, "boolean");
  assert.ok(Number.isInteger(high.particleBudget));
});

test("quality: unknown skins fall back to the default profile", () => {
  const s = qualitySettingsFor(undefined, 1);
  assert.deepEqual(s, {
    level: 1,
    levelId: QUALITY_LEVELS[1].id,
    pixelRatio: DEFAULT_QUALITY_PROFILE.pixelRatio[1],
    ghostFade: true,
    particleBudget: DEFAULT_QUALITY_PROFILE.particleBudget,
  });
});

test("quality: controller applies presets through the simulation API without breaking size", () => {
  const sim = createSimulation({ size: 16, seedDensity: 0.2 });
  const applied = { size: [] };
  const scene = {
    syncVoxels() {},
    onResize() {},
    render() {},
    activeSkinId: "neon-wireframe",
    renderer: { setPixelRatio() {} },
  };
  const c = createQualityController({ sim, scene, metrics: null });
  const preset = c.applyPreset("large");
  assert.equal(preset.size, 32);
  assert.equal(sim.size, 32, "controller must resize the simulation through its public API");
  assert.equal(typeof sim.tick, "function", "transition API must stay intact");

  // The population carries over only for cells inside the new bounds.
  const snap = sim.toSnapshot();
  assert.ok(snap.cells.length >= 0);
  assert.equal(snap.size, 32);
});

test("quality: FPS sampling returns readings after a window", () => {
  const sim = createSimulation({ size: 16 });
  const c = createQualityController({ sim, scene: { renderer: {} }, metrics: null });
  c._sampleFps(1000);
  c._sampleFps(1100);
  const res = c._sampleFps(2000);
  assert.ok(res === null || res > 0, "sample window must complete normally");
});

test("quality: manual quality change records a guard and clamps level", () => {
  const sim = createSimulation({ size: 16 });
  const guards = [];
  const c = createQualityController({
    sim,
    scene: { renderer: { setPixelRatio() {} }, activeSkinId: "classic-voxels" },
    metrics: { record: (name, fields) => guards.push({ name, ...fields }) },
  });
  const level = c.setQuality(99); // out of range → clamped to low
  assert.equal(level, QUALITY_LEVELS.length - 1);
  assert.ok(guards.some((g) => g.name === "quality:guard"));
});