/**
 * Browser bootstrap for the 3D Game of Life scaffold.
 *
 * Wires the shared simulation core and contracts to the three.js scene:
 *   1. Create a seeded lattice (20% density by default).
 *   2. Mount the 3D scene into a container element.
 *   3. Tick the simulation at SPEED ticks/sec using the active rule-set
 *      (B/S birth/survival counts) and refresh the voxels.
 *
 * The engine itself stays headless — this module is the only DOM-aware glue
 * for the demo entrypoint. Later skin/rule/multiplayer tasks can replace or
 * extend this bootstrap without touching src/engine or src/contracts.
 */

import { createSimulation } from "./engine/simulation.js";
import { DEFAULTS, DEFAULT_RULE_SET, DEFAULT_SKIN } from "./contracts/index.js";
import { createScene } from "./scene/scene.js";

/**
 * Boot the demo.
 * @param {HTMLElement} container Target element for the canvas.
 * @param {Object} [options] Overrides `{ size?, seedDensity?, speed?, skin?, ruleSet? }`.
 * @returns {Object} `{ simulation, scene, start, stop, step, reset, dispose,
 *   applyRuleSet, getActiveRule, isRunning }`
 */
export function main(container, options = {}) {
  const size = options.size ?? DEFAULTS.SIZE;
  const seedDensity = options.seedDensity ?? DEFAULTS.SEED_DENSITY;
  const speed = options.speed ?? DEFAULTS.SPEED;
  const skin = options.skin ?? DEFAULT_SKIN;
  let activeRule = options.ruleSet ?? DEFAULT_RULE_SET;

  let simulation = createSimulation({ size, seedDensity });
  let scene = createScene(container, { simulation, skin });

  let timer = null;
  let running = false;
  let disposed = false;

  /** Whether the simulation is currently auto-stepping. */
  const isRunning = () => running;

  /** Advance one generation and refresh the voxel lattice. */
  function step() {
    if (disposed) return;
    simulation.tick(activeRule);
    scene.syncVoxels();
    scene.render();
    return simulation.generation;
  }

  /**
   * Swap the rule-set the running simulation uses. Applies from the very next
   * tick — no restart or page reload needed.
   * @returns {Object} The now-active rule-set.
   */
  function applyRuleSet(ruleSet) {
    if (disposed) return activeRule;
    activeRule = ruleSet ?? DEFAULT_RULE_SET;
    return activeRule;
  }

  /** The rule-set currently applied to live ticks. */
  function getActiveRule() {
    return activeRule;
  }

  /** Begin/continue automatic stepping at the configured speed. */
  function start() {
    if (running || disposed) return;
    running = true;
    timer = setInterval(step, 1000 / speed);
    step();
  }

  /** Stop automatic stepping (the scene stays interactive). */
  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timer);
    timer = null;
  }

  /** Clear and re-seed the lattice, then redraw. */
  function reset(density) {
    stop();
    simulation.initialize(density ?? seedDensity);
    scene.syncVoxels();
    scene.render();
    return simulation;
  }

  /** Tear down timers and the WebGL renderer (used by HMR / tests). */
  function dispose() {
    disposed = true;
    stop();
    scene.dispose();
  }

  return {
    simulation,
    scene,
    start,
    stop,
    step,
    reset,
    dispose,
    isRunning,
    applyRuleSet,
    getActiveRule,
  };
}