// Conway's Game of Life — pure simulation engine.
// No DOM or global-state dependencies. Safe to import in the browser
// (as an ES module) or to require() from Node for testing.

/**
 * A 2D grid of cell states for Conway's Game of Life.
 *
 * Cell values are numeric: 1 === alive, 0 === dead. The grid stores its
 * state as a flat typed array for speed, and exposes row/col helpers so
 * callers never need to think about the flat layout.
 */
export class Grid {
  /**
   * @param {number} rows
   * @param {number} cols
   * @param {Int8Array|number[]|null} [cells] - optional initial state;
   *        if omitted the grid starts empty (all dead).
   */
  constructor(rows, cols, cells = null) {
    if (!Number.isInteger(rows) || rows <= 0) {
      throw new Error(`rows must be a positive integer, got ${rows}`);
    }
    if (!Number.isInteger(cols) || cols <= 0) {
      throw new Error(`cols must be a positive integer, got ${cols}`);
    }

    this.rows = rows;
    this.cols = cols;

    if (cells === null) {
      this.cells = new Int8Array(rows * cols);
    } else {
      const source = cells instanceof Int8Array ? cells : Int8Array.from(cells);
      if (source.length !== rows * cols) {
        throw new Error(
          `cells length ${source.length} does not match rows*cols (${rows * cols})`,
        );
      }
      this.cells = source.slice();
    }
  }

  /** Flat index for a (row, col) coordinate. */
  #index(row, col) {
    return row * this.cols + col;
  }

  /**
   * Validate that a coordinate is within bounds.
   * @param {number} row
   * @param {number} col
   * @throws {RangeError} if out of bounds.
   */
  #checkBounds(row, col) {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      throw new RangeError(
        `cell (${row}, ${col}) out of bounds for ${this.rows}x${this.cols} grid`,
      );
    }
  }

  /**
   * Get the state of a cell (1 = alive, 0 = dead).
   * @param {number} row
   * @param {number} col
   * @returns {number}
   */
  get(row, col) {
    this.#checkBounds(row, col);
    return this.cells[this.#index(row, col)];
  }

  /**
   * Set the state of a cell.
   * @param {number} row
   * @param {number} col
   * @param {number} value - truthy/1 for alive, 0/falsy for dead.
   * @returns {number} the value that was set.
   */
  set(row, col, value) {
    this.#checkBounds(row, col);
    const v = value ? 1 : 0;
    this.cells[this.#index(row, col)] = v;
    return v;
  }

  /**
   * Toggle a cell between alive and dead.
   * @param {number} row
   * @param {number} col
   * @returns {number} the new state (1 or 0).
   */
  toggle(row, col) {
    this.#checkBounds(row, col);
    const idx = this.#index(row, col);
    const next = this.cells[idx] ? 0 : 1;
    this.cells[idx] = next;
    return next;
  }

  /** Reset every cell to dead. */
  clear() {
    this.cells.fill(0);
  }

  /**
   * Deep-copy this grid.
   * @returns {Grid}
   */
  clone() {
    return new Grid(this.rows, this.cols, this.cells);
  }

  /**
   * Return a plain 2D array (rows of cols) snapshot of the current state.
   * Useful for rendering and for interop with the `gameOfLifeStep` hook.
   * @returns {number[][]}
   */
  toArray() {
    const out = new Array(this.rows);
    for (let r = 0; r < this.rows; r += 1) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c += 1) {
        row[c] = this.cells[r * this.cols + c];
      }
      out[r] = row;
    }
    return out;
  }

  /**
   * Build a Grid from a 2D array of 0/1 values.
   * @param {number[][]} array
   * @returns {Grid}
   */
  static fromArray(array) {
    if (!Array.isArray(array) || array.length === 0) {
      throw new Error('fromArray requires a non-empty 2D array');
    }
    const rows = array.length;
    const cols = array[0].length;
    const cells = new Int8Array(rows * cols);
    for (let r = 0; r < rows; r += 1) {
      const row = array[r];
      if (row.length !== cols) {
        throw new Error(`fromArray: ragged row ${r} (expected ${cols} cols)`);
      }
      for (let c = 0; c < cols; c += 1) {
        cells[r * cols + c] = row[c] ? 1 : 0;
      }
    }
    return new Grid(rows, cols, cells);
  }
}

/**
 * Count the 8 Moore-neighbourhood live cells around (row, col).
 *
 * @param {Int8Array} cells - flat cell array.
 * @param {number} rows
 * @param {number} cols
 * @param {number} row
 * @param {number} col
 * @param {boolean} toroidal - if true, edges wrap (torus); if false, edges
 *        are hard walls (out-of-bounds neighbours count as dead).
 * @returns {number} live neighbour count (0–8).
 */
function countLiveNeighbours(cells, rows, cols, row, col, toroidal) {
  let count = 0;
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      let nr = row + dr;
      let nc = col + dc;

      if (toroidal) {
        // Wrap modulo grid dimensions.
        if (nr < 0) nr += rows;
        else if (nr >= rows) nr -= rows;
        if (nc < 0) nc += cols;
        else if (nc >= cols) nc -= cols;
      } else if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) {
        // Hard wall: out-of-bounds neighbours are dead.
        continue;
      }

      count += cells[nr * cols + nc];
    }
  }
  return count;
}

/**
 * Compute the next generation of a grid using Conway's rules (B3/S23):
   *   - A live cell with 2 or 3 live neighbours survives.
   *   - A dead cell with exactly 3 live neighbours is born.
   *   - All other cells die or stay dead.
 *
 * This is a pure function: it does not mutate `grid` and returns a new Grid.
 *
 * @param {Grid} grid - current generation.
 * @param {{ toroidal?: boolean }} [options]
 * @param {boolean} [options.toroidal=true] - wrap edges (torus) when true,
 *        otherwise treat the border as a hard wall.
 * @returns {Grid} the next generation.
 */
export function step(grid, options = {}) {
  const { toroidal = true } = options;
  const { rows, cols, cells } = grid;
  const next = new Int8Array(cells.length);

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const idx = r * cols + c;
      const alive = cells[idx];
      const neighbours = countLiveNeighbours(cells, rows, cols, r, c, toroidal);

      // Conway B3/S23.
      if (alive) {
        next[idx] = neighbours === 2 || neighbours === 3 ? 1 : 0;
      } else {
        next[idx] = neighbours === 3 ? 1 : 0;
      }
    }
  }

  return new Grid(rows, cols, next);
}

/**
 * Convenience: advance a grid by N generations (pure — returns a new Grid).
 * @param {Grid} grid
 * @param {number} generations
 * @param {{ toroidal?: boolean }} [options]
 * @returns {Grid}
 */
export function stepN(grid, generations, options = {}) {
  if (!Number.isInteger(generations) || generations < 0) {
    throw new Error(`generations must be a non-negative integer, got ${generations}`);
  }
  let current = grid;
  for (let i = 0; i < generations; i += 1) {
    current = step(current, options);
  }
  return current;
}

/**
 * Pure helper operating on a plain 2D array, for the optional
 * `window.gameOfLifeStep` grading hook described in README.md.
 *
 * @param {number[][]} cells - 2D array of 0/1.
 * @param {{ toroidal?: boolean }} [options]
 * @returns {number[][]} new 2D array = next generation (input is not mutated).
 */
export function stepArray(cells, options = {}) {
  const grid = Grid.fromArray(cells);
  return step(grid, options).toArray();
}
