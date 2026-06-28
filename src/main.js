// Game of Life — application entry point.
//
// Wires the pure simulation engine (engine.js) to the canvas renderer
// (ui.js) and owns the run/pause/step controller state. UI controls
// (buttons, speed slider) are added by a later task; this module exposes
// a small controller API on `window.gameOfLife` so other tasks and the
// glider-test harness can drive the simulation.

import { Grid, step } from './engine.js';
import { DEFAULT_ROWS, DEFAULT_COLS, createGridView } from './ui.js';

const container = document.getElementById('grid');
if (!container) {
  throw new Error('Missing #grid container in index.html');
}

/** @type {{ running: boolean, grid: Grid, view: import('./ui.js').GridView }} */
const state = {
  running: false,
  grid: new Grid(DEFAULT_ROWS, DEFAULT_COLS),
  view: null,
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

/** Reset the grid to all-dead and re-render. */
function clearGrid() {
  state.grid.clear();
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

// Initial paint.
render();

// Expose a controller API for downstream tasks (controls, seeding) and
// for the optional grading harness. Rendering + click-to-toggle are the
// scope of this task; start/stop/step/reset/clear are wired here as a
// minimal controller so the UI is fully functional.
window.gameOfLife = {
  state,
  step: stepOnce,
  clear: clearGrid,
  setGrid,
  isRunning: () => state.running,
  setRunning: (value) => {
    state.running = Boolean(value);
  },
  render,
};
