/**
 * Determinism + no-divergence tests for the authoritative-host sync model.
 *
 * The acceptance criteria require: "same seed + rule + tick count produce
 * identical world state" and "host handoff ... continues without grid
 * divergence". These tests verify the pure engine determinism and the
 * session snapshot/delta round-trip convergence properties that make the
 * relay model sound, without needing a browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSimulation } from "../engine/simulation.js";
import { DEFAULT_RULE_SET } from "../contracts/index.js";
import {
  diffSnapshots,
  mergeIntoSnapshot,
  snapshotFromMap,
  cellsToKeyMap,
  applyChangesToMap,
} from "./protocol.js";

function liveSet(sim) {
  return cellsToKeyMap(sim.toSnapshot());
}

test("determinism: same seed + rule + tick count => identical world", () => {
  const simA = createSimulation({ size: 16, seedDensity: 0.2, seed: 42 });
  const simB = createSimulation({ size: 16, seedDensity: 0.2, seed: 42 });
  assert.equal(simA.population, simB.population);

  for (let i = 0; i < 25; i++) {
    simA.tick(DEFAULT_RULE_SET);
    simB.tick(DEFAULT_RULE_SET);
  }
  assert.equal(simA.generation, simB.generation);
  assert.deepEqual([...liveSet(simA).keys()].sort(), [...liveSet(simB).keys()].sort());
});

test("determinism: different seeds diverge (sanity check)", () => {
  const a = createSimulation({ size: 16, seedDensity: 0.2, seed: 1 });
  const b = createSimulation({ size: 16, seedDensity: 0.2, seed: 2 });
  a.tick(DEFAULT_RULE_SET);
  b.tick(DEFAULT_RULE_SET);
  assert.notDeepEqual([...liveSet(a).keys()].sort(), [...liveSet(b).keys()].sort());
});

test("no-divergence: a joiner applying full snapshots stays identical to the host", () => {
  const host = createSimulation({ size: 16, seedDensity: 0.2, seed: 7 });
  const joiner = createSimulation({ size: 16, seedDensity: 0, seed: 999 }); // different start

  for (let i = 0; i < 12; i++) {
    host.tick(DEFAULT_RULE_SET);
    // Host broadcasts its full snapshot each generation; joiner applies it.
    joiner.fromSnapshot(host.toSnapshot());
  }
  assert.equal(joiner.generation, host.generation);
  assert.deepEqual([...liveSet(joiner).keys()].sort(), [...liveSet(host).keys()].sort());
  assert.equal(joiner.population, host.population);
});

test("no-divergence: delta application from the last full snapshot converges", () => {
  const host = createSimulation({ size: 16, seedDensity: 0.2, seed: 11 });
  const joinerMap = new Map();
  let lastFull = null;

  for (let i = 0; i < 8; i++) {
    host.tick(DEFAULT_RULE_SET);
    const snap = host.toSnapshot();
    const asMap = cellsToKeyMap(snap);
    if (!lastFull) {
      // First broadcast: full snapshot (joiners apply it wholesale).
      for (const k of asMap.keys()) joinerMap.set(k, 1);
      lastFull = snap;
    } else {
      // Later broadcasts: delta changes applied to the mirrored map.
      const { changes } = diffSnapshots(lastFull, snap);
      applyChangesToMap(joinerMap, changes);
      lastFull = snap;
    }
  }

  const joinerSnapshot = snapshotFromMap(joinerMap, {
    generation: host.generation,
    size: host.size,
  });
  assert.deepEqual(
    [...cellsToKeyMap(joinerSnapshot).keys()].sort(),
    [...liveSet(host).keys()].sort(),
  );
});

test("no-divergence: mergeIntoSnapshot keeps a mirrored world in sync", () => {
  const host = createSimulation({ size: 16, seedDensity: 0.2, seed: 13 });
  let mirror = host.toSnapshot(); // cache the authoritative base

  for (let i = 0; i < 6; i++) {
    host.tick(DEFAULT_RULE_SET);
    const { changes } = diffSnapshots(mirror, host.toSnapshot());
    mirror = mergeIntoSnapshot(mirror, {
      base: mirror.generation,
      changes,
      generation: host.generation,
    });
  }
  assert.equal(mirror.generation, host.generation);
  assert.deepEqual([...cellsToKeyMap(mirror).keys()].sort(), [...liveSet(host).keys()].sort());
});