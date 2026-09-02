/**
 * Browser bootstrap for the 3D Game of Life scaffold.
 *
 * Wires the shared simulation core, contracts, rule-set engine, skin registry
 * and HUD selector to the three.js scene:
 *   1. Restore the previously selected skin from localStorage (or default).
 *   2. Create a seeded lattice (20% density by default).
 *   3. Mount the 3D scene into a container element.
 *   4. Tick the simulation at SPEED ticks/sec using the active rule-set
 *      (B/S birth/survival counts) and refresh the voxels.
 *   5. Render continuously with requestAnimationFrame so dying fades, glow
 *      pulses and orbit damping animate smoothly; skin switches rebuild the
 *      scene's visual layer without touching the simulation state.
 *
 * The engine itself stays headless — this module is the only DOM-aware glue
 * for the demo entrypoint.
 */

import { createSimulation } from "./engine/simulation.js";
import { DEFAULTS, DEFAULT_RULE_SET } from "./contracts/index.js";
import { createScene } from "./scene/scene.js";
import { SKINS, DEFAULT_SKIN_ID } from "./skins/skins.js";
import {
  createSkinPanel,
  readStoredSkinId,
  writeStoredSkinId,
} from "./ui/skins-panel.js";

/**
 * Boot the demo.
 * @param {HTMLElement} container Target element for the canvas.
 * @param {Object} [options] Overrides `{ size?, seedDensity?, speed?, skin?, ruleSet? }`.
 * @returns {Object} `{ simulation, scene, start, stop, step, reset, setSkin,
 *   dispose, isRunning, activeSkinId, applyRuleSet, getActiveRule }`
 */
export function main(container, options = {}) {
  const size = options.size ?? DEFAULTS.SIZE;
  const seedDensity = options.seedDensity ?? DEFAULTS.SEED_DENSITY;
  const speed = options.speed ?? DEFAULTS.SPEED;
  const requestedSkinId =
    (options.skin && options.skin.id) || readStoredSkinId() || DEFAULT_SKIN_ID;
  let activeRule = options.ruleSet ?? DEFAULT_RULE_SET;

  let simulation = createSimulation({ size, seedDensity });
  let scene = createScene(container, { simulation, skinId: requestedSkinId });

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

  /** Switch the visual skin without touching the running simulation. */
  function setSkin(skinId) {
    if (disposed) return false;
    const applied = scene.applySkin(skinId);
    if (applied) writeStoredSkinId(skinId);
    scene.render();
    return applied;
  }

  /** Clear and re-seed the lattice, then redraw. */
  function reset(density) {
    stop();
    simulation.initialize(density ?? seedDensity);
    scene.syncVoxels();
    scene.render();
    return simulation;
  }

  // ---- HUD skin selector ----------------------------------------------------------
  const panel = createSkinPanel({
    skins: SKINS,
    activeId: requestedSkinId,
    onSelect: setSkin,
  });

  // ---- Continuous render loop -------------------------------------------------------
  let rafId = null;
  function frame() {
    if (disposed) return;
    scene.render();
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  /** Tear down timers and the WebGL renderer (used by HMR / tests). */
  function dispose() {
    disposed = true;
    stop();
    cancelAnimationFrame(rafId);
    scene.dispose();
    const panelEl = document.querySelector(".skin-panel");
    if (panelEl?.parentNode) panelEl.parentNode.removeChild(panelEl);
  }

  start();

  return {
    simulation,
    scene,
    start,
    stop,
    step,
    reset,
    setSkin,
    dispose,
    isRunning,
    get activeSkinId() {
      return panel.getActiveId();
    },
    applyRuleSet,
    getActiveRule,
  };
}