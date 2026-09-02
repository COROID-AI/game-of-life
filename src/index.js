/**
 * Entrypoint for the 3D Game of Life demo.
 *
 * Imports the bootstrap (engine + scene) and starts it as soon as the DOM is
 * ready. This module may also expose the classic 2D `window.gameOfLifeStep`
 * hook from the previous single-file demo so glider-test.html keeps passing.
 */

import { main } from "./main.js";
import { createSimulation } from "./engine/simulation.js";
import {
  PRESET_RULE_SETS,
  getPreset,
  encodeRuleShare,
  decodeRuleShare,
} from "./engine/rules.js";
import { createRuleEditor } from "./ui/rules-editor.js";

const app = document.getElementById("app");
if (!app) {
  throw new Error('index.html must contain an element with id="app"');
}

const handle = main(app, { size: 16, seedDensity: 0.2, speed: 4 });
window.__life3d = handle;

// ---- Custom rule editor (swap rules live, save/load/share) ----------------
let editor = null;
try {
  editor = createRuleEditor({
    presets: PRESET_RULE_SETS,
    initial: handle.getActiveRule(),
    onApply: (ruleSet) => handle.applyRuleSet(ruleSet),
    shareEncode: encodeRuleShare,
    shareDecode: decodeRuleShare,
  });
  window.__life3d.editor = editor;
} catch (err) {
  console.error("Could not start the rule editor:", err);
}

// Preserve a couple of engine-level conveniences on the window handle.
window.getPresetRule = getPreset;

/**
 * Compat hook for glider-test.html: pure, non-mutating classic 2D Conway.
 * Runs the plane-constrained engine (z=0) so the glider translates +1/+1
 * every 4 generations exactly like the original 2D demo. Returns a new array.
 */
window.gameOfLifeStep = function gameOfLifeStep(cells) {
  const rows = Array.isArray(cells) ? cells.length : 0;
  const cols = rows > 0 && Array.isArray(cells[0]) ? cells[0].length : 0;
  const size = Math.max(rows, cols) + 2; // margin so hard walls never interfere
  const sim = createSimulation({ size, seedDensity: 0 });

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (cells[y][x] === 1) sim.setCell(x, y, 0, 1);
    }
  }
  sim.tick({ plane: "z", planeOffset: 0 });

  const next = new Array(rows);
  for (let y = 0; y < rows; y++) {
    const row = new Array(cols).fill(0);
    for (let x = 0; x < cols; x++) {
      row[x] = sim.getCell(x, y, 0);
    }
    next[y] = row;
  }
  return next;
};

// ---- Minimal HUD wiring (stats + play/pause/step) --------------------------
const playPauseBtn = document.getElementById("play-pause-btn");
const stepBtn = document.getElementById("step-btn");
const genEl = document.getElementById("generation");
const popEl = document.getElementById("population");

function updateHud() {
  if (genEl) genEl.textContent = String(handle.simulation.generation);
  if (popEl) popEl.textContent = String(handle.simulation.population);
  if (playPauseBtn) playPauseBtn.textContent = handle.isRunning() ? "Pause" : "Play";
}

if (playPauseBtn) {
  playPauseBtn.addEventListener("click", () => {
    if (handle.isRunning()) handle.stop();
    else handle.start();
    updateHud();
  });
}
if (stepBtn) {
  stepBtn.addEventListener("click", () => {
    handle.step();
    updateHud();
  });
}

setInterval(updateHud, 200);

handle.start();
updateHud();