import { test } from "node:test";
import assert from "node:assert/strict";

import { createSimulation } from "./simulation.js";
import { BLINKER, BLOCK, GLIDER, setPattern, getPattern, createSimulationWithPattern } from "./patterns.js";

/** Plane-constrained rule-set preserving classic 2D Conway in the z=0 plane. */
const PLANE_Z = { plane: "z", planeOffset: 0 };

function liveSet(sim, planeZ = false) {
  const set = new Set();
  const size = sim.size;
  const half = Math.floor(size / 2);
  for (let x = -half; x < half; x++) {
    for (let y = -half; y < half; y++) {
      for (let z = -half; z < half; z++) {
        if (sim.getCell(x, y, z) === 1) set.add(`${x},${y},${z}`);
      }
    }
  }
  return set;
}

function cellCount(sim) {
  return liveSet(sim).size;
}

test("patterns: built-in pattern ids resolve and have the expected cell counts", () => {
  assert.equal(getPattern("blinker").length, 3);
  assert.equal(getPattern("block").length, 4);
  assert.equal(getPattern("glider").length, 5);
  assert.throws(() => getPattern("does-not-exist"), /unknown pattern/);
  assert.throws(() => getPattern(123), /unknown pattern/);
});

test("glider: classic 2D glider translates +1/+1 every 4 generations (plane-constrained)", () => {
  const sim = createSimulation({ size: 20, seedDensity: 0 });
  setPattern(sim, GLIDER, [2, 2, 0]);

  const start = liveSet(sim);
  for (let i = 0; i < 4; i++) sim.tick(PLANE_Z);
  const after4 = liveSet(sim);

  // Same shape, translated +1 in x and +1 in y.
  const expected4 = new Set([...start].map((k) => {
    const [x, y, z] = k.split(",").map(Number);
    return `${x + 1},${y + 1},${z}`;
  }));
  assert.deepEqual(after4, expected4);

  for (let i = 0; i < 16; i++) sim.tick(PLANE_Z); // total 20
  const after20 = liveSet(sim);
  const expected20 = new Set([...start].map((k) => {
    const [x, y, z] = k.split(",").map(Number);
    return `${x + 5},${y + 5},${z}`;
  }));
  assert.deepEqual(after20, expected20);
});

test("blinker: classic 2D blinker oscillates with period 2 (plane-constrained)", () => {
  const sim = createSimulation({ size: 20, seedDensity: 0 });
  setPattern(sim, BLINKER, [-1, 0, 0]);

  const t0 = liveSet(sim);
  sim.tick(PLANE_Z);
  const t1 = liveSet(sim);
  sim.tick(PLANE_Z);
  const t2 = liveSet(sim);

  // t0 is a horizontal bar, t1 is the vertical bar (3 cells), t2 returns.
  assert.notDeepEqual(t1, t0);
  assert.deepEqual(t2, t0);
  assert.equal(t1.size, 3);
});

test("block: 2x2 slab stays stable under plane-constrained and pure-3D evolution", () => {
  // Plane-constrained (classic 2D block).
  const sim = createSimulation({ size: 20, seedDensity: 0 });
  setPattern(sim, BLOCK, [-1, -1, 0]);
  const before = liveSet(sim);
  sim.tick(PLANE_Z);
  assert.deepEqual(liveSet(sim), before);

  // Pure 3D: the 2×2×1 slab in the z=0 plane is a still life under the full
  // 26-neighbour set too (each cell has 3 live neighbours, interior cells 4).
  const sim3 = createSimulation({ size: 20, seedDensity: 0 });
  setPattern(sim3, BLOCK, [-1, -1, 0]);
  const before3 = liveSet(sim3);
  sim3.tick();
  assert.deepEqual(liveSet(sim3), before3);
});

test("engine: createSimulation exposes the documented API surface", () => {
  const sim = createSimulation({ size: 8, seedDensity: 0 });
  assert.equal(typeof sim.getCell, "function");
  assert.equal(typeof sim.setCell, "function");
  assert.equal(typeof sim.tick, "function");
  assert.equal(typeof sim.initialize, "function");
  assert.equal(typeof sim.clear, "function");
  assert.equal(sim.size, 8);
  assert.equal(sim.generation, 0);
  assert.equal(sim.population, 0);
});

test("engine: setCell/getCell round-trip and ignore out-of-bounds", () => {
  const sim = createSimulation({ size: 8, seedDensity: 0 });
  assert.equal(sim.getCell(0, 0, 0), 0);
  sim.setCell(2, -3, 1, 1);
  assert.equal(sim.getCell(2, -3, 1), 1);
  sim.setCell(2, -3, 1, 0);
  assert.equal(sim.getCell(2, -3, 1), 0);

  // Out-of-bounds are ignored silently.
  sim.setCell(99, 0, 0, 1);
  assert.equal(sim.getCell(99, 0, 0), 0);
  sim.setCell(0, -99, 0, 1);
  assert.equal(sim.getCell(0, -99, 0), 0);
});

test("engine: initialize(seedDensity) reseeds and clear() empties", () => {
  const sim = createSimulation({ size: 10, seedDensity: 0 });
  assert.equal(sim.population, 0);

  sim.initialize(0.5);
  const p50 = sim.population;
  assert.ok(p50 > 0, "a 0.5-density lattice should contain live cells");
  assert.ok(p50 <= 10 * 10 * 10, "population bounded by volume");

  sim.initialize(0.05);
  const p05 = sim.population;
  assert.ok(p05 < p50, "lower density produces fewer live cells");

  sim.clear();
  assert.equal(sim.population, 0);
  assert.equal(sim.generation, 0);
});

test("engine: default 26-neighbour evolution births off-plane cells (real 3D)", () => {
  // Verify pure-3D by placing an L-corner: (0,0,0), (1,0,0), (0,1,0).
  // Under the full 26-neighbour set, (1,1,0) will be born (it has 3 live
  // neighbours) and (0,0,0) has 2 live neighbours so it survives — off-plane
  // adjacency drives behaviour beyond any single 2D plane.
  const sim = createSimulation({ size: 12, seedDensity: 0 });
  sim.setCell(0, 0, 0, 1);
  sim.setCell(1, 0, 0, 1);
  sim.setCell(0, 1, 0, 1);
  sim.tick(); // full 26-neighbour set: (1,1,0) has 3 live neighbours → born
  assert.equal(sim.getCell(1, 1, 0), 1);
  // (0,0,0) has 2 live neighbours → survives under B3/S23.
  assert.equal(sim.getCell(0, 0, 0), 1);
});

test("engine: generation counter increments and population is reported", () => {
  const sim = createSimulation({ size: 20, seedDensity: 0 });
  setPattern(sim, GLIDER, [2, 2, 0]);
  const p0 = sim.population;
  assert.equal(p0, 5);
  sim.tick(PLANE_Z);
  sim.tick(PLANE_Z);
  assert.equal(sim.generation, 2);
  assert.equal(sim.population, 5); // glider stays 5 live cells
});

test("engine: toSnapshot/fromSnapshot round-trip preserves generation and cells", () => {
  const sim = createSimulation({ size: 12, seedDensity: 0 });
  setPattern(sim, BLINKER, [-1, 0, 0]);
  sim.tick(PLANE_Z);
  sim.tick(PLANE_Z);
  const snap = sim.toSnapshot();

  const restored = createSimulation({ size: 12, seedDensity: 0 });
  restored.fromSnapshot(snap);
  assert.equal(restored.generation, 2);
  assert.equal(restored.size, 12);
  assert.deepEqual(liveSet(restored), liveSet(sim));
});

test("engine: custom rule-set tick function can override the transition", () => {
  const sim = createSimulation({ size: 12, seedDensity: 0 });
  sim.setCell(0, 0, 0, 1);

  // Custom rule that flips every cell state (a not-very-useful "complement"
  // transition) — proves the rule-set hook is honored.
  const complement = {
    id: "complement",
    name: "Complement",
    mode: "custom-function",
    tick() {
      const next = new Map();
      const size = sim.size;
      const half = Math.floor(size / 2);
      for (let x = -half; x < half; x++) {
        for (let y = -half; y < half; y++) {
          for (let z = -half; z < half; z++) {
            next.set(`${x},${y},${z}`, sim.getCell(x, y, z) === 1 ? 0 : 1);
          }
        }
      }
      return next;
    },
  };
  sim.tick(complement);
  assert.equal(sim.getCell(0, 0, 0), 0);
});

test("createSimulationWithPattern builds a seeded lattice in one call", () => {
  const sim = createSimulationWithPattern("glider", { size: 24, offset: [6, 6, 0] });
  assert.equal(sim.population, 5);
  assert.equal(sim.getCell(6, 7, 0), 1);
  assert.equal(sim.getCell(8, 8, 0), 1);
});

test("countAlive respects dead cells set explicitly to 0", () => {
  const sim = createSimulation({ size: 8, seedDensity: 0 });
  sim.setCell(0, 0, 0, 1);
  sim.setCell(1, 0, 0, 0);
  assert.equal(sim.population, 1);
});