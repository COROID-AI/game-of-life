// Conway's Game of Life — named patterns and a grid loader.
//
// Each pattern is an array of [row, col] coordinate pairs describing the
// live cells of the shape relative to an origin of (0, 0). Patterns are
// intentionally framework-agnostic: they are plain data so they can be
// imported in the browser, unit-tested in Node, or serialized for demos.

/**
 * The glider — a small 5-cell spaceship that travels diagonally.
 * Canonical orientation (heads down-right):
 *
 *     .X.
 *     ..X
 *     XXX
 */
export const glider = [
  [0, 1],
  [1, 2],
  [2, 0],
  [2, 1],
  [2, 2],
];

/**
 * The blinker — the smallest oscillator (period 2).
 * Horizontal phase:
 *
 *     XXX
 */
export const blinker = [
  [0, 0],
  [0, 1],
  [0, 2],
];

/**
 * The block — a 2x2 still life (period 1, never changes).
 *
 *     XX
 *     XX
 */
export const block = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
];

/**
 * The Gosper glider gun — the first known pattern with unbounded growth.
 * Emits a new glider every 30 generations. Bounding box is 36 cols x 9 rows.
 */
export const gosperGliderGun = [
  [0, 24],
  [1, 22],
  [1, 24],
  [2, 12],
  [2, 13],
  [2, 20],
  [2, 21],
  [2, 34],
  [2, 35],
  [3, 11],
  [3, 15],
  [3, 20],
  [3, 21],
  [3, 34],
  [3, 35],
  [4, 0],
  [4, 1],
  [4, 10],
  [4, 16],
  [4, 20],
  [4, 21],
  [5, 0],
  [5, 1],
  [5, 10],
  [5, 14],
  [5, 16],
  [5, 17],
  [5, 22],
  [5, 24],
  [6, 10],
  [6, 16],
  [6, 24],
  [7, 11],
  [7, 15],
  [8, 12],
  [8, 13],
];

/** Alias for callers that prefer the hyphenated name from the plan. */
export const gosperGliderGunPattern = gosperGliderGun;

/**
 * All named patterns keyed by a lowercase, hyphen-friendly id. Useful for
 * wiring up a pattern picker in the UI or for data-driven tests.
 */
export const patterns = {
  glider,
  blinker,
  block,
  'gosper-glider-gun': gosperGliderGun,
  gosperGliderGun,
};

/**
 * Place a pattern onto a grid by translating each [row, col] coordinate by
 * the given origin and marking those cells alive.
 *
 * Cells that fall outside the grid are skipped (clamped to bounds) rather
 * than throwing, so large patterns (e.g. the gun) can be safely seeded into
 * a viewport without crashing. The grid is mutated in place and also
 * returned for chaining.
 *
 * @param {import('./engine.js').Grid} grid - target grid (mutated).
 * @param {number[][]} pattern - array of [row, col] live-cell offsets.
 * @param {[number, number]} [origin=[0, 0]] - [row, col] to translate the
 *        pattern to; defaults to the top-left corner.
 * @returns {import('./engine.js').Grid} the same grid instance, for chaining.
 */
export function loadPattern(grid, pattern, origin = [0, 0]) {
  if (!grid || typeof grid.set !== 'function') {
    throw new Error('loadPattern: expected a Grid instance with a set(row, col, value) method');
  }
  if (!Array.isArray(pattern)) {
    throw new Error('loadPattern: pattern must be an array of [row, col] pairs');
  }

  const [originRow, originCol] = Array.isArray(origin) ? origin : [0, 0];

  for (const cell of pattern) {
    if (!Array.isArray(cell) || cell.length < 2) continue;
    const row = originRow + Number(cell[0]);
    const col = originCol + Number(cell[1]);
    // Skip out-of-bounds cells instead of throwing via grid.set/#checkBounds.
    if (
      Number.isInteger(row) &&
      Number.isInteger(col) &&
      row >= 0 &&
      col >= 0 &&
      row < grid.rows &&
      col < grid.cols
    ) {
      grid.set(row, col, 1);
    }
  }

  return grid;
}
