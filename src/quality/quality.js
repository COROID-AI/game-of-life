/**
 * Grid-size presets + automatic quality guards for the 3D Game of Life.
 *
 * Performance goal: the default grid preset must stay interactive in every
 * skin, and a large-grid preset must remain playable. The scene already draws
 * live cells with a single instanced draw call (`THREE.InstancedMesh`); this
 * module layers the remaining pieces on top without touching the simulation
 * determinism contract:
 *
 *   - a `GRID_PRESETS` catalogue (small / default / medium / large) that the
 *     HUD "Grid" control applies by growing/shrinking the lattice attributes
 *     through the pure engine,
 *   - an FPS meter that samples the render loop and, when the framerate falls
 *     below an interactive threshold, lowers a quality level (pixel-ratio
 *     cap → ghost/dynamic layers → particle budget) and emits a
 *     `quality:guard` metric so the performance ceiling is known,
 *   - per-skin `QUALITY_PROFILES` tuning (pixel-ratio cap, ghost fade toggle,
 *     particle budget) so quality guards are deterministic per skin,
 *   - the module keeps every engine call through the public simulation API
 *     (initialize/clear/fromSnapshot) — never mutates the tick contract.
 *
 * Metrics are emitted through the same local sink as the rest of the app.
 */

import { DEFAULTS } from "../contracts/simulation.js";
import { METRIC_EVENTS } from "../analytics/metrics.js";

/** Target FPS considered "interactive" for guard purposes. */
export const INTERACTIVE_FPS = 45;

/** Grid presets shown in the HUD (size per axis). */
export const GRID_PRESETS = Object.freeze([
  { id: "small", label: "Small (12³)", size: 12 },
  { id: "default", label: "Default (16³)", size: 16 },
  { id: "medium", label: "Medium (24³)", size: 24 },
  { id: "large", label: "Large (32³)", size: 32 },
]);

/** Auto quality levels (higher index = more aggressive degradation). */
export const QUALITY_LEVELS = Object.freeze([
  { id: "high", description: "Full detail (pixel ratio 2, ghost fades, full particles)" },
  { id: "medium", description: "Pixel ratio 1.5, full ghost fades" },
  { id: "low", description: "Pixel ratio 1, shortened ghost fades, lower particle budget" },
]);

/** Per-skin quality tuning (deterministic values used by the guards). */
export const QUALITY_PROFILES = Object.freeze({
  "classic-voxels": { pixelRatio: [2, 1.5, 1], ghostFade: [true, true, true], particleBudget: 12288 },
  "neon-wireframe": { pixelRatio: [2, 1.5, 1], ghostFade: [true, true, true], particleBudget: 8192 },
  organic: { pixelRatio: [2, 1.5, 1], ghostFade: [true, true, true], particleBudget: 12288 },
});

/** Best-guess default profile for unknown/third-party skins. */
export const DEFAULT_QUALITY_PROFILE = Object.freeze({
  pixelRatio: [2, 1.5, 1],
  ghostFade: [true, true, true],
  particleBudget: 12288,
});

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Serializable renderer settings that a quality level implies. */
export function qualitySettingsFor(profile, level) {
  const p = profile ?? DEFAULT_QUALITY_PROFILE;
  const i = clamp(level, 0, QUALITY_LEVELS.length - 1);
  return {
    level: i,
    levelId: QUALITY_LEVELS[i].id,
    pixelRatio: p.pixelRatio[i] ?? 1.5,
    ghostFade: (p.ghostFade[i] ?? true) === true,
    particleBudget: p.particleBudget ?? 12288,
  };
}

/**
 * Create the grid/quality controller bound to one simulation + scene handle.
 * @param {Object} options
 * @param {Object} options.sim Simulation handle (engine/simulation.js).
 * @param {Object} options.scene Scene handle (scene/scene.js).
 * @param {Object} options.metrics Optional metrics reporter.
 * @returns {{ applyPreset, getPreset, getQuality, setQuality, sampleFps,
 *   tickFrameStats, getFps, getLastGuard, setSize, destroy }}
 */
export function createQualityController({ sim, scene, metrics = null }) {
  let preset = GRID_PRESETS.find((p) => p.size === sim.size) ?? GRID_PRESETS[1];
  let qualityLevel = 0;
  let lastGuard = null;

  // ---- FPS meter ------------------------------------------------------------
  let frames = 0;
  let fpsWindowStart = performance.now();
  let fps = 60;
  let lastFrameTime = performance.now();

  function sampleFps(now) {
    frames += 1;
    const elapsed = now - fpsWindowStart;
    if (elapsed >= 1000) {
      fps = Math.round((frames * 1000) / elapsed);
      frames = 0;
      fpsWindowStart = now;
      return fps;
    }
    return null;
  }

  /** Call from the render loop every frame; returns current FPS or null. */
  function tickFrameStats(now) {
    const prevFrame = lastFrameTime;
    lastFrameTime = now ?? performance.now();
    const res = sampleFps(lastFrameTime);
    considerGuard(lastFrameTime);
    return res;
  }

  function emit(name, fields = {}) {
    if (metrics && typeof metrics.record === "function") {
      try {
        metrics.record(name, fields);
      } catch {
        /* ignore */
      }
    }
  }

  function qualityProfile() {
    const skinId = scene?.activeSkinId ?? "neon-wireframe";
    return QUALITY_PROFILES[skinId] ?? DEFAULT_QUALITY_PROFILE;
  }

  function applyQualitySettings() {
    const settings = qualitySettingsFor(qualityProfile(), qualityLevel);
    if (
      scene.renderer &&
      typeof scene.renderer.setPixelRatio === "function" &&
      typeof window !== "undefined"
    ) {
      scene.renderer.setPixelRatio(
        Math.min(window.devicePixelRatio || 1, settings.pixelRatio),
      );
    }
    if (scene.setQualitySettings) scene.setQualitySettings(settings);
    if (scene.render) scene.render();
    return settings;
  }

  function setQuality(level) {
    const next = clamp(level, 0, QUALITY_LEVELS.length - 1);
    if (next === qualityLevel) return qualityLevel;
    qualityLevel = next;
    const settings = applyQualitySettings();
    emit(METRIC_EVENTS.QUALITY_GUARD, { level: qualityLevel, levelId: settings.levelId, reason: "manual" });
    return qualityLevel;
  }

  function considerGuard(now) {
    if (fps < INTERACTIVE_FPS && qualityLevel < QUALITY_LEVELS.length - 1) {
      const level = qualityLevel + 1;
      qualityLevel = level;
      const settings = applyQualitySettings();
      lastGuard = { level, levelId: settings.levelId, fps, time: now };
      emit(METRIC_EVENTS.QUALITY_GUARD, { level, levelId: settings.levelId, reason: "auto", fps });
    }
  }

  /** Apply a grid preset by id; keeps the seeded world within bounds and
   * never changes the transition contract. */
  function applyPreset(presetId) {
    const next = GRID_PRESETS.find((p) => p.id === presetId) ?? GRID_PRESETS[1];
    if (next.size === sim.size) {
      preset = next;
      return preset;
    }
    // The pure engine API (resize) rebuilds the lattice at the new size and
    // keeps every surviving cell inside the new bounds deterministically.
    if (typeof sim.resize === "function") {
      sim.resize(next.size);
    } else {
      // Fallback for engine versions without resize(): rebuild + re-add cells.
      const prevCells = sim.toSnapshot();
      sim.initialize(0);
      const half = Math.floor(next.size / 2);
      for (const cell of prevCells.cells) {
        const [x, y, z] = cell;
        if (x >= -half && x < half && y >= -half && y < half && z >= -half && z < half) {
          sim.setCell(x, y, z, 1);
        }
      }
    }
    preset = next;
    if (scene.syncVoxels) scene.syncVoxels();
    if (scene.onResize) scene.onResize();
    if (scene.render) scene.render();
    emit(METRIC_EVENTS.GRID_PRESET, { size: next.size, id: next.id });
    return preset;
  }

  function setSize(size) {
    const next = GRID_PRESETS.find((p) => p.size === size);
    return applyPreset(next?.id ?? "default");
  }

  function getPreset() {
    return preset;
  }
  function getQuality() {
    return qualityLevel;
  }
  function getFps() {
    return fps;
  }
  function getLastGuard() {
    return lastGuard;
  }

  return {
    applyPreset,
    getPreset,
    setSize,
    getQuality,
    setQuality,
    tickFrameStats,
    getFps,
    getLastGuard,
    // Test hook: expose the pure FPS window logic.
    _sampleFps: sampleFps,
  };
}