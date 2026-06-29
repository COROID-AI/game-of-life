// Conway's Game of Life — UI layer.
//
// Renders the simulation grid onto a <canvas> and translates user input
// (clicks/drags) into cell toggles. This module is intentionally kept
// separate from the pure simulation engine (engine.js): it owns DOM and
// rendering concerns only and is driven by an external controller that
// decides when to step the simulation.

/**
 * Default grid dimensions (per plan: 40x40).
 * @type {number}
 */
export const DEFAULT_ROWS = 40;
export const DEFAULT_COLS = 40;

/** Logical size of a single cell in CSS pixels. @type {number} */
const DEFAULT_CELL_SIZE = 14;
/** Width of the grid line between cells in CSS pixels. @type {number} */
const GRID_LINE_WIDTH = 1;
/** Min/max cell size for zoom clamping (inclusive). @type {number} */
export const MIN_CELL_SIZE = 4;
export const MAX_CELL_SIZE = 28;
/** Per-click zoom delta in CSS pixels. @type {number} */
const ZOOM_STEP = 2;

/**
 * Resolve a canvas pixel coordinate to a grid (row, col) coordinate.
 *
 * @param {number} x - canvas-space x (CSS pixels).
 * @param {number} y - canvas-space y (CSS pixels).
 * @returns {{ row: number, col: number }}
 */
function pixelToCell(x, y, cellSize) {
  const stride = cellSize + GRID_LINE_WIDTH;
  const col = Math.floor(x / stride);
  const row = Math.floor(y / stride);
  return { row, col };
}

/**
 * Create and return the canvas element for the grid, sized for the given
 * dimensions. The canvas is returned unattached; the caller appends it.
 *
 * @param {number} rows
 * @param {number} cols
 * @returns {HTMLCanvasElement}
 */
function createCanvas(rows, cols, cellSize) {
  const canvas = document.createElement('canvas');
  canvas.className = 'life-canvas';
  canvas.width = cols * (cellSize + GRID_LINE_WIDTH) + GRID_LINE_WIDTH;
  canvas.height = rows * (cellSize + GRID_LINE_WIDTH) + GRID_LINE_WIDTH;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Game of Life grid, ${rows} by ${cols} cells`);
  canvas.tabIndex = 0;
  return canvas;
}

/**
 * A canvas-based renderer + interaction surface for a Game of Life grid.
 *
 * The renderer is stateless with respect to the simulation: it draws
 * whatever {@link GridView#draw} is given and reports toggles via the
 * `onToggle` callback. The owning controller decides whether toggles are
 * permitted (e.g. only when paused).
 */
export class GridView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container - element to mount the canvas into.
   * @param {number} [opts.rows=DEFAULT_ROWS] - grid row count.
   * @param {number} [opts.cols=DEFAULT_COLS] - grid column count.
   * @param {(row: number, col: number) => void} [opts.onToggle]
   *        Called when the user clicks/taps a cell to toggle it. The
   *        controller decides whether to honour it (e.g. only when paused).
   */
  constructor({ container, rows = DEFAULT_ROWS, cols = DEFAULT_COLS, onToggle } = {}) {
    if (!container) {
      throw new Error('GridView requires a container element');
    }

    this.rows = rows;
    this.cols = cols;
    this.onToggle = typeof onToggle === 'function' ? onToggle : null;
    this.cellSize = DEFAULT_CELL_SIZE;

    this.canvas = createCanvas(rows, cols, this.cellSize);
    this.ctx = this.canvas.getContext('2d');
    container.appendChild(this.canvas);

    this.#bindEvents();
  }

  /**
   * Re-render the grid from a flat Int8Array (or array-like) of 0/1 cells.
   * Called on every simulation step and after any toggle.
   *
   * @param {Int8Array|number[]} cells - flat cell array of length rows*cols.
   */
  draw(cells) {
    const { ctx, rows, cols, cellSize } = this;
    const stride = cellSize + GRID_LINE_WIDTH;

    // Background (dead cells / grid lines).
    ctx.fillStyle = '#111827'; // slate-800
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Live cells.
    ctx.fillStyle = '#34d399'; // emerald-400
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (cells[r * cols + c]) {
          ctx.fillRect(
            GRID_LINE_WIDTH + c * stride,
            GRID_LINE_WIDTH + r * stride,
            cellSize,
            cellSize,
          );
        }
      }
    }
  }

  /**
   * Current cell size in CSS pixels (read-only accessor).
   * @returns {number}
   */
  getCellSize() {
    return this.cellSize;
  }

  /**
   * Set a new cell size, clamped to [MIN_CELL_SIZE, MAX_CELL_SIZE].
   * Resizes the canvas backing store and immediately re-renders the last
   * drawn grid so the change is visible on the same frame (no flash).
   *
   * @param {number} size - desired cell size in CSS pixels.
   * @param {Int8Array|number[]} [cells] - current cell array to redraw.
   * @returns {number} the clamped cell size actually applied.
   */
  setCellSize(size, cells) {
    const clamped = Math.min(
      MAX_CELL_SIZE,
      Math.max(MIN_CELL_SIZE, Math.round(size)),
    );
    if (clamped === this.cellSize) return clamped;
    this.cellSize = clamped;
    // Resize backing store to match the new cell size.
    this.canvas.width = this.cols * (clamped + GRID_LINE_WIDTH) + GRID_LINE_WIDTH;
    this.canvas.height = this.rows * (clamped + GRID_LINE_WIDTH) + GRID_LINE_WIDTH;
    if (cells) this.draw(cells);
    return clamped;
  }

  /**
   * Zoom in by ZOOM_STEP px (clamped). Redraws the given cells.
   * @param {Int8Array|number[]} [cells]
   * @returns {number} the new cell size.
   */
  zoomIn(cells) {
    return this.setCellSize(this.cellSize + ZOOM_STEP, cells);
  }

  /**
   * Zoom out by ZOOM_STEP px (clamped). Redraws the given cells.
   * @param {Int8Array|number[]} [cells]
   * @returns {number} the new cell size.
   */
  zoomOut(cells) {
    return this.setCellSize(this.cellSize - ZOOM_STEP, cells);
  }

  /**
   * Render from a Grid instance (convenience wrapper around draw).
   *
   * @param {import('./engine.js').Grid} grid
   */
  drawGrid(grid) {
    this.draw(grid.cells);
  }

  /** Remove all DOM listeners and detach the canvas. */
  destroy() {
    this.#unbindEvents();
    this.canvas.remove();
  }

  // ---- internals --------------------------------------------------------

  #bindEvents() {
    // Bound handlers are stored so they can be removed in destroy().
    this.#handlePointerDown = (event) => this.#onPointerDown(event);
    this.#handlePointerMove = (event) => this.#onPointerMove(event);
    this.#handlePointerUp = () => this.#onPointerUp();

    this.canvas.addEventListener('pointerdown', this.#handlePointerDown);
    this.canvas.addEventListener('pointermove', this.#handlePointerMove);
    // pointerup/leave can happen off-canvas during a drag.
    window.addEventListener('pointerup', this.#handlePointerUp);
  }

  #unbindEvents() {
    if (this.#handlePointerDown) {
      this.canvas.removeEventListener('pointerdown', this.#handlePointerDown);
    }
    if (this.#handlePointerMove) {
      this.canvas.removeEventListener('pointermove', this.#handlePointerMove);
    }
    if (this.#handlePointerUp) {
      window.removeEventListener('pointerup', this.#handlePointerUp);
    }
  }

  #onPointerDown(event) {
    this.#dragging = true;
    this.#lastToggled = null;
    this.#toggleAt(event);
    event.preventDefault();
  }

  #onPointerMove(event) {
    if (!this.#dragging) return;
    this.#toggleAt(event);
  }

  #onPointerUp() {
    this.#dragging = false;
    this.#lastToggled = null;
  }

  /**
   * Toggle the cell under a pointer event, skipping repeats during a drag
   * so a single click-drag doesn't flip a cell multiple times.
   */
  #toggleAt(event) {
    if (!this.onToggle) return;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;

    const { row, col } = pixelToCell(x, y, this.cellSize);
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;

    const key = `${row},${col}`;
    if (this.#lastToggled === key) return; // already toggled this drag
    this.#lastToggled = key;

    this.onToggle(row, col);
  }

  // Private fields (declared as instance props for broad JS support).
  #dragging = false;
  #lastToggled = null;
  #handlePointerDown = null;
  #handlePointerMove = null;
  #handlePointerUp = null;
}

/**
 * Build the grid UI inside the given container and return the GridView.
 *
 * Convenience factory used by main.js.
 *
 * @param {object} opts - same options as {@link GridView}.
 * @returns {GridView}
 */
export function createGridView(opts) {
  return new GridView(opts);
}
