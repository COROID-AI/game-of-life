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