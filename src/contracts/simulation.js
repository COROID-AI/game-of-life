/**
 * Shared simulation defaults.
 *
 * Phase-2 tasks (rule-set, skin, multiplayer) must consume these constants
 * rather than redefining world dimensions locally, so every scene and network
 * peer renders and steps the same lattice.
 */
export const DEFAULTS = Object.freeze({
  /** Lattice half-extent on each axis; the world spans [-SIZE, SIZE-1]. */
  SIZE: 16,
  /** Population density used by initialize(seedDensity). */
  SEED_DENSITY: 0.2,
  /** Number of ticks per second in the demo scene. */
  SPEED: 4,
});

export const WORLD_VOLUME = DEFAULTS.SIZE * DEFAULTS.SIZE * DEFAULTS.SIZE;

/**
 * Largest cubic lattice edge a world may carry. This is the single shared cap
 * consumed by the grid presets, the multiplayer wire layer (net/protocol.js),
 * world-state validation, and the pure engine's restore path, so every layer
 * agrees on the same bound.
 */
export const MAX_GRID_SIZE = 32;

/**
 * Absolute ceiling for live-cell entries in one serializable world state
 * (the full volume of the largest lattice). Validators use this to reject
 * snapshots whose population could exhaust CPU/GPU/instancing budgets.
 */
export const MAX_WORLD_CELLS = MAX_GRID_SIZE * MAX_GRID_SIZE * MAX_GRID_SIZE;