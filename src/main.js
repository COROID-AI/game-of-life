// Game of Life — application entry point.
//
// Wires the pure simulation engine (engine.js) to the canvas renderer
// (ui.js) and owns the run/pause/step controller state, including the
// Start/Stop/Step/Reset/Clear buttons and the speed slider.

import { Grid, step } from './engine.js';
import { DEFAULT_ROWS, DEFAULT_COLS, createGridView } from './ui.js';

const container = document.getElementById('grid');
if (!container) {
  throw new Error('Missing #grid container in index.html');
}

/** Default tick interval (ms) — matches the slider's initial value. */
const DEFAULT_TICK_INTERVAL_MS = 200;

/**
 * Controller state. `initialGrid` is the snapshot used by Reset; it is
 * populated by setInitialGrid() (called by the pattern-seeding task).
 *
 * @type {{
 *   running: boolean,
 *   grid: Grid,
 *   view: import('./ui.js').GridView,
 *   initialGrid: Grid | null,
 *   tickIntervalMs: number,
 *   timerId: number | null,
 * }}
 */
const state = {
  running: false,
  grid: new Grid(DEFAULT_ROWS, DEFAULT_COLS),
  view: null,
  initialGrid: null,
  tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
  timerId: null,
};

/**
 * Re-render the current grid state.
 * Called after every mutation (toggle, step, reset, clear).
 */
function render() {
  state.view.drawGrid(state.grid);
}

/**
 * Toggle a cell — only honoured while the simulation is paused, per the
 * acceptance criteria. Passed as the GridView onToggle callback.
 */
function handleToggle(row, col) {
  if (state.running) return; // ignore edits while running
  state.grid.toggle(row, col);
  render();
}

// Build the canvas grid view.
state.view = createGridView({
  container,
  rows: DEFAULT_ROWS,
  cols: DEFAULT_COLS,
  onToggle: handleToggle,
});

/** Advance the simulation by one generation and re-render. */
function stepOnce() {
  state.grid = step(state.grid);
  render();
}

/**
 * Begin the tick loop. Idempotent: a no-op when already running. Always
 * clears any existing interval before starting a fresh one so re-entry
 * (e.g. after a speed change) never leaks intervals.
 */
function startLoop() {
  if (state.running) return;
  if (state.timerId !== null) {
    clearInterval(state.timerId);
  }
  state.running = true;
  state.timerId = setInterval(stepOnce, state.tickIntervalMs);
}

/**
 * Halt the tick loop. Idempotent: a no-op when not running. Leaves the
 * grid in its current state (no auto-reset).
 */
function stopLoop() {
  if (state.timerId !== null) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  state.running = false;
}

/**
 * Restart the loop at the current interval so a speed change takes effect
 * immediately (the next tick fires sooner). Only acts while running.
 */
function restartLoop() {
  if (!state.running) return;
  if (state.timerId !== null) {
    clearInterval(state.timerId);
  }
  state.timerId = setInterval(stepOnce, state.tickIntervalMs);
}

/** Reset the grid to all-dead, stop the loop, and re-render. */
function clearGrid() {
  stopLoop();
  state.grid.clear();
  render();
}

/**
 * Restore the initial seeded pattern. When no initial grid has been set,
 * Reset is equivalent to Clear (per acceptance criteria).
 */
function resetGrid() {
  stopLoop();
  if (state.initialGrid) {
    state.grid = state.initialGrid.clone();
  } else {
    state.grid.clear();
  }
  render();
}

/**
 * Capture a snapshot of the given grid as the initial state for Reset.
 * The active grid is also replaced with a fresh clone of the snapshot.
 *
 * @param {Grid} grid
 */
function setInitialGrid(grid) {
  state.initialGrid = grid.clone();
  state.grid = grid.clone();
  render();
}

/**
 * Replace the active grid with a fresh one of the given dimensions and
 * re-render. Useful for the pattern-seeding task.
 *
 * @param {Grid} grid
 */
function setGrid(grid) {
  state.grid = grid;
  render();
}

// --- Wire up the DOM controls ---------------------------------------------

/**
 * Safely look up a required element by id.
 * @param {string} id
 * @returns {HTMLElement}
 */
function getById(id) {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing #${id} element in index.html`);
  }
  return el;
}

const startBtn = getById('start-btn');
const stopBtn = getById('stop-btn');
const stepBtn = getById('step-btn');
const resetBtn = getById('reset-btn');
const clearBtn = getById('clear-btn');
const speedSlider = /** @type {HTMLInputElement} */ (getById('speed-slider'));
const speedValue = getById('speed-value');

startBtn.addEventListener('click', startLoop);
stopBtn.addEventListener('click', stopLoop);
// Step is a no-op while running to avoid double-stepping at the next tick.
stepBtn.addEventListener('click', () => {
  if (state.running) return;
  stepOnce();
});
resetBtn.addEventListener('click', resetGrid);
clearBtn.addEventListener('click', clearGrid);

speedSlider.addEventListener('input', () => {
  state.tickIntervalMs = Number(speedSlider.value);
  speedValue.textContent = `${state.tickIntervalMs}ms`;
  restartLoop();
});

// Initial paint.
render();

// Expose a controller API for downstream tasks (seeding) and for the
// optional grading harness.
window.gameOfLife = {
  state,
  step: stepOnce,
  start: startLoop,
  stop: stopLoop,
  reset: resetGrid,
  clear: clearGrid,
  setGrid,
  setInitialGrid,
  isRunning: () => state.running,
  setRunning: (value) => {
    if (value) startLoop();
    else stopLoop();
  },
  render,
};
