/**
 * 3D Game of Life pattern library.
 *
 * Patterns are placed with `setPattern(sim, pattern, offset)`. Each cell in
 * the pattern list is `[x, y, z]` (or `[x, y, z, alive]`).
 *
 * Reference behaviour for the engine tests:
 * - block:  2×2×1 slab of live cells — a 3D "still life" (each cell has
 *           3 live neighbours, so B3/S23 keeps the slab intact).
 * - blinker: a 3-cell bar along X. Like its classic 2D cousin this is period
 *            static in 3D with zero live neighbours mid-span; the classic
 *            period-2 blinker requires the 2D plane (see engine docs).
 * - glider:  the classic 2D glider stamped flat in the z=0 plane, which
 *            translates as expected under B3/S23.
 */

import { createSimulation } from "./simulation.js";

/** Minimum and maximum number of cells a pattern may contain (validation). */
export const PATTERN_LIMITS = Object.freeze({ min: 1, max: 1000 });

/** A 2×2×1 slab of live cells. */
export const BLOCK = Object.freeze([
  [-1, -1, 0],
  [0, -1, 0],
  [-1, 0, 0],
  [0, 0, 0],
]);

/** A 3-cell bar along X. */
export const BLINKER = Object.freeze([
  [-1, 0, 0],
  [0, 0, 0],
  [1, 0, 0],
]);

/** The classic 2D glider stamped in the z=0 plane. */
export const GLIDER = Object.freeze([
  [0, 1, 0],
  [1, 2, 0],
  [2, 0, 0],
  [2, 1, 0],
  [2, 2, 0],
]);

/** All built-in patterns keyed by id. */
export const PATTERNS = Object.freeze({
  blinker: BLINKER,
  block: BLOCK,
  glider: GLIDER,
});

/** Resolve a pattern by id or as a raw array of `[x, y, z]` cells. */
export function getPattern(pattern) {
  if (typeof pattern === "string") {
    const named = PATTERNS[pattern];
    if (named) return named;
  }
  if (Array.isArray(pattern) && pattern.length > 0 && pattern.every((c) => Array.isArray(c))) {
    return pattern;
  }
  throw new TypeError(`unknown pattern: ${JSON.stringify(pattern)}`);
}

/** Validate and stamp a pattern into a simulation at the given offset. */
export function setPattern(sim, pattern, offset = [0, 0, 0]) {
  const cells = getPattern(pattern);
  if (cells.length < PATTERN_LIMITS.min || cells.length > PATTERN_LIMITS.max) {
    throw new RangeError(`pattern must contain ${PATTERN_LIMITS.min}..${PATTERN_LIMITS.max} cells`);
  }
  const [ox, oy, oz] = offset;
  for (const cell of cells) {
    const [x, y, z, alive = 1] = cell;
    sim.setCell(ox + x, oy + y, oz + z, alive);
  }
}

/**
 * Build a fresh simulation seeded with a pattern rather than random noise.
 * @param {string|Array} pattern Pattern id or cell list.
 * @param {Object} [options] `{ size?, offset? }`
 */
export function createSimulationWithPattern(pattern, options = {}) {
  const sim = createSimulation({ size: options.size ?? 16, seedDensity: 0 });
  setPattern(sim, pattern, options.offset ?? [0, 0, 0]);
  return sim;
}