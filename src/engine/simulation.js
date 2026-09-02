/**
 * Pure 3D Game of Life simulation engine.
 *
 * This module is engine-agnostic by design: it never imports three.js, the
 * DOM, or any renderer, so headless consumers (tests, multiplayer servers,
 * rule-set tasks) can step the same lattice.
 *
 * World model
 * -----------
 * The lattice is a cube of `size` cells per axis centered on the origin:
 * every coordinate is an integer in [-(size/2), size/2 - 1]. The engine keeps
 * its own internal cell set (`Map` of `"x,y,z"` -> 1) and `getCell`/`setCell`/
 * `tick` operate on that set. `initialize`/`clear` replace it. A cell is
 * either 0 (dead) or 1 (alive).
 *
 * Neighbourhood
 * -------------
 * By default the full 26-neighbour Moore set in 3D (every cell except
 * `(0,0,0)` in the 3×3×3 box around a cell). Edges are hard walls (no wrap).
 * A rule-set may restrict evolution to a classic plane by setting `plane`
 * (`'x' | 'y' | 'z'`) plus `planeOffset`; only cells on that plane are
 * candidates and neighbourhood counting uses the 8 in-plane deltas. This
 * preserves the 2D demo's exact Conway behaviour (glider, blinker, block)
 * inside the 3D world.
 *
 * Rules
 * ------
 * Default rule-set: classic Conway B3/S23 lifted to 3D — a dead cell is born
 * with exactly 3 live neighbours, a live cell survives with 2 or 3.
 * `tick(ruleSet)` accepts an optional override (see contracts/ruleSet.js);
 * a custom rule-set may also provide its own `tick` function that returns
 * the next generation as a `Map` of `"x,y,z"` -> 0|1.
 */

export const DEFAULTS = Object.freeze({
  size: 16,
  seedDensity: 0.2,
});

import { MAX_GRID_SIZE, MAX_WORLD_CELLS } from "../contracts/simulation.js";

const NBRS = (() => {
  const list = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        list.push([dx, dy, dz]);
      }
    }
  }
  return list;
})();

/** 8 in-plane deltas for each axis (x=0, y=1, z=2). */
const PLANE_NBRS = [
  NBRS.filter((d) => d[0] === 0),
  NBRS.filter((d) => d[1] === 0),
  NBRS.filter((d) => d[2] === 0),
];

function key(x, y, z) {
  return `${x},${y},${z}`;
}

/** Guard used by restore paths: never build or inherit an oversized lattice. */
function assertSizeWithinCap(size) {
  if (!Number.isInteger(size) || size < 1 || size > MAX_GRID_SIZE) {
    throw new RangeError(`world size must be an integer in [1, ${MAX_GRID_SIZE}]`);
  }
}

/** Guard used by restore paths: never adopt more cells than the cap allows. */
function assertCellsWithinCap(count) {
  if (!Number.isInteger(count) || count < 0 || count > MAX_WORLD_CELLS) {
    throw new RangeError(`cell count must be in [0, ${MAX_WORLD_CELLS}]`);
  }
}

function createWorld(sizeArg, seedDensity, rng) {
  const size = Number.isInteger(sizeArg) && sizeArg > 0 ? sizeArg : DEFAULTS.size;
  // Hard cap on the initial lattice too (grid presets are bounded; never let
  // an unbounded createSimulation allocate a huge cube).
  if (size > MAX_GRID_SIZE) {
    throw new RangeError(`world size ${size} exceeds the cap of ${MAX_GRID_SIZE}`);
  }
  const density = typeof seedDensity === "number" ? seedDensity : DEFAULTS.seedDensity;
  if (!Number.isFinite(density) || density < 0 || density > 1) {
    throw new RangeError("seedDensity must be a number between 0 and 1");
  }

  const half = Math.floor(size / 2);
  const cells = new Map();
  for (let x = -half; x < half; x++) {
    for (let y = -half; y < half; y++) {
      for (let z = -half; z < half; z++) {
        if (rng() < density) cells.set(key(x, y, z), 1);
      }
    }
  }
  return { size, half, cells };
}

/**
 * Create a 3D Game of Life simulation.
 *
 * @param {Object} [options]
 * @param {number} [options.size=16] Cubic lattice edge length.
 * @param {number} [options.seedDensity=0.2] Initial random population density.
 * @param {number} [options.seed] Optional seed for reproducible trials.
 * @returns {Object} Simulation handle (getCell/setCell/tick/initialize/clear/…)
 */
export function createSimulation(options = {}) {
  const { size = DEFAULTS.size, seedDensity = DEFAULTS.seedDensity } = options;

  // Deterministic rng unless the caller passes their own seed.
  let rng = Math.random;
  if (Number.isFinite(options.seed)) {
    let s = options.seed >>> 0 || 1;
    rng = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
  }

  let world = createWorld(size, seedDensity, rng);
  let generation = 0;

  function countAlive() {
    let n = 0;
    for (const alive of world.cells.values()) if (alive === 1) n++;
    return n;
  }

  function inBounds(x, y, z) {
    const half = world.half;
    return (
      Number.isInteger(x) && x >= -half && x < half &&
      Number.isInteger(y) && y >= -half && y < half &&
      Number.isInteger(z) && z >= -half && z < half
    );
  }

  /** True when the cell is alive, false when dead or out of bounds. */
  function getCell(x, y, z) {
    if (!inBounds(x, y, z)) return 0;
    return world.cells.get(key(x, y, z)) ?? 0;
  }

  /** Set a cell state. Out-of-bounds calls are ignored. */
  function setCell(x, y, z, alive) {
    if (!inBounds(x, y, z)) return;
    const k = key(x, y, z);
    if (alive) world.cells.set(k, 1);
    else world.cells.delete(k);
  }

  function countNeighbours(x, y, z, deltas) {
    let n = 0;
    for (const [dx, dy, dz] of deltas) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (inBounds(nx, ny, nz) && getCell(nx, ny, nz) === 1) n++;
    }
    return n;
  }

  /**
   * Advance the world one generation.
   * @param {Object} [ruleSet] Optional override (see contracts/ruleSet.js).
   * @returns {number} New population after the tick.
   */
  function tick(ruleSet) {
    const rules = ruleSet ?? {};
    const plane = rules.plane ?? null;
    const axisIndex = plane === "x" ? 0 : plane === "y" ? 1 : plane === "z" ? 2 : null;
    const planeOffset =
      axisIndex === null ? 0 : Number.isInteger(rules.planeOffset) ? rules.planeOffset : 0;
    const deltas = axisIndex === null ? NBRS : PLANE_NBRS[axisIndex];

    // Custom transition override (rule-set contract).
    if (typeof rules.tick === "function") {
      const next = rules.tick({ size: world.size, half: world.half, generation }, getCell);
      if (next instanceof Map) {
        const replaced = new Map();
        for (const [k, v] of next) replaced.set(k, v === 1 ? 1 : 0);
        world.cells = replaced;
        generation += 1;
        return countAlive();
      }
    }

    const birth = Array.isArray(rules.birth) ? rules.birth : [3];
    const survive = Array.isArray(rules.survive) ? rules.survive : [2, 3];

    const next = new Map();
    for (let x = -world.half; x < world.half; x++) {
      for (let y = -world.half; y < world.half; y++) {
        for (let z = -world.half; z < world.half; z++) {
          const coord = axisIndex === 0 ? x : axisIndex === 1 ? y : z;
          if (axisIndex !== null && coord !== planeOffset) continue;
          const alive = getCell(x, y, z) === 1;
          const n = countNeighbours(x, y, z, deltas);
          const keep = alive && survive.includes(n);
          const born = !alive && birth.includes(n);
          if (keep || born) next.set(key(x, y, z), 1);
        }
      }
    }
    world.cells = next;
    generation += 1;
    return countAlive();
  }

  /** Replace the lattice with a fresh random population. */
  function initialize(seedDensity) {
    world = createWorld(world.size, seedDensity ?? DEFAULTS.seedDensity, rng);
    generation = 0;
    return world.cells;
  }

  /** Remove every live cell leaving an empty lattice. */
  function clear() {
    world.cells = new Map();
    generation = 0;
    return world.cells;
  }

  /** Snapshot the current state for persistence / multiplayer sync. */
  function toSnapshot() {
    const cells = [];
    for (const k of world.cells.keys()) {
      const [x, y, z] = k.split(",").map(Number);
      cells.push([x, y, z, 1]);
    }
    return { generation, size: world.size, cells };
  }

  /** Restore a snapshot produced by `toSnapshot` (or a world-state contract object). */
  function fromSnapshot(snapshot) {
    if (!snapshot || !Number.isInteger(snapshot.size) || !Array.isArray(snapshot.cells)) {
      throw new TypeError("snapshot must contain integer size and a cells array");
    }
    // Hard caps: a promoted host or a bridged snapshot must never resurrect an
    // unbounded lattice (CPU O(size^3)) or an unbounded cell list (GPU/relay).
    assertSizeWithinCap(snapshot.size);
    assertCellsWithinCap(snapshot.cells.length);
    const half = Math.floor(snapshot.size / 2);
    world = { size: snapshot.size, half, cells: new Map() };
    for (const cell of snapshot.cells) {
      if (cell[3] === 1) {
        const x = cell[0];
        const y = cell[1];
        const z = cell[2];
        // Keep the engine invariant: coordinates are integers in [-half, half).
        if (x >= -half && x < half && y >= -half && y < half && z >= -half && z < half) {
          world.cells.set(key(x, y, z), 1);
        }
      }
    }
    generation = snapshot.generation ?? 0;
    return world.cells;
  }

  /**
   * Resize the cubic lattice (grid-size presets). The world is rebuilt at the
   * new size; coordinates inside the new bounds keep their alive/dead state,
   * out-of-bounds cells are dropped. This never mutates the transition
   * rule-set and stays a pure engine operation (no DOM/three.js).
   * @param {number} newSize Positive integer edge length.
   * @returns {Object} The resized simulation handle (same object).
   */
  function resize(newSize) {
    const sizeArg = Number.isInteger(newSize) && newSize > 0 ? newSize : DEFAULTS.size;
    // Hard cap: grid presets never exceed MAX_GRID_SIZE; keep an explicit
    // guard here so a bridge/resize call cannot allocate an oversized cube.
    if (sizeArg > MAX_GRID_SIZE) {
      throw new RangeError(`resize target ${sizeArg} exceeds the cap of ${MAX_GRID_SIZE}`);
    }
    const prev = world.cells;
    world = { size: sizeArg, half: Math.floor(sizeArg / 2), cells: new Map() };
    const half = Math.floor(sizeArg / 2);
    for (const k of prev.keys()) {
      const [x, y, z] = k.split(",").map(Number);
      if (x >= -half && x < half && y >= -half && y < half && z >= -half && z < half) {
        world.cells.set(k, 1);
      }
    }
    generation = 0;
    return world.cells;
  }

  return {
    /** Current generation counter (incremented by each successful tick). */
    get generation() { return generation; },
    /** Cubic lattice edge length. */
    get size() { return world.size; },
    /** Lattice half-extent (coordinate bound, exclusive). */
    get half() { return world.half; },
    /** Number of live cells. */
    get population() { return countAlive(); },
    getCell,
    setCell,
    tick,
    initialize,
    clear,
    resize,
    toSnapshot,
    fromSnapshot,
  };
}

/**
 * Combination of the default simulation handle with the classic Conway rules,
 * exported for API compatibility with the task description's method name.
 */
export function createSimulationAsDocumented() {
  return createSimulation();
}

export { WORLD_VOLUME as MAX_CELLS } from "../contracts/simulation.js";