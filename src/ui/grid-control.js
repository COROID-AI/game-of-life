/**
 * HUD grid-size + quality control for the 3D Game of Life.
 *
 * Adds a compact "Grid" control to the main HUD with:
 *   - a preset dropdown (Small 12³ / Default 16³ / Medium 24³ / Large 32³),
 *   - a quality auto/manual toggle (High / Medium / Low),
 *   - a live FPS readout so players can see the performance budget.
 *
 * The control is purely presentational: it forwards preset/quality changes to
 * the quality controller (src/quality/quality.js) and displays FPS sampled by
 * the render loop. The simulation engine is untouched directly — preset swaps
 * go through the pure simulation API via the controller.
 *
 * Element ids match browser verification tooling:
 *   - #grid-preset-wrap (label group)
 *   - #grid-preset      (select)
 *   - #quality-level    (select)
 *   - #fps-stat         (stat span)
 */

import { GRID_PRESETS, QUALITY_LEVELS } from "../quality/quality.js";

/** DOM ids used by verification tooling. */
export const GRID_IDS = Object.freeze({
  wrap: "grid-preset-wrap",
  preset: "grid-preset",
  quality: "quality-level",
  fps: "fps-stat",
});

/**
 * Create the grid control panel inside #hud.
 * @param {Object} options
 * @param {Object} options.controller Quality controller from quality.js.
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createGridControl({ controller }) {
  const host = document.getElementById("hud");
  if (!host) return { el: null, destroy: () => {} };

  const wrap = document.createElement("label");
  wrap.id = GRID_IDS.wrap;
  wrap.className = "grid-preset-wrap";
  wrap.title = "Grid size preset — larger lattices cost more GPU/CPU";

  const label = document.createElement("span");
  label.className = "grid-label";
  label.textContent = "Grid";
  wrap.appendChild(label);

  const select = document.createElement("select");
  select.id = GRID_IDS.preset;
  select.className = "grid-select";
  select.setAttribute("aria-label", "Grid size preset");
  for (const preset of GRID_PRESETS) {
    select.appendChild(new Option(preset.label, preset.id));
  }
  select.value = controller.getPreset?.()?.id ?? "default";

  const qualityWrap = document.createElement("label");
  qualityWrap.className = "quality-wrap";
  qualityWrap.title = "Quality level — auto-guard lowers detail when FPS drops";
  const qualityLabel = document.createElement("span");
  qualityLabel.className = "quality-label";
  qualityLabel.textContent = "Quality";
  const quality = document.createElement("select");
  quality.id = GRID_IDS.quality;
  quality.className = "quality-select";
  for (let i = 0; i < QUALITY_LEVELS.length; i++) {
    quality.appendChild(new Option(QUALITY_LEVELS[i].id, String(i)));
  }
  quality.value = String(controller.getQuality?.() ?? 0);

  const fps = document.createElement("span");
  fps.id = GRID_IDS.fps;
  fps.className = "fps-stat";
  fps.textContent = `${controller.getFps?.() ?? "—"} FPS`;

  select.addEventListener("change", () => {
    controller.applyPreset?.(select.value);
    const preset = controller.getPreset?.();
    if (preset) wrap.title = `Grid size preset — ${preset.size}³ (${preset.label})`;
  });
  quality.addEventListener("change", () => {
    controller.setQuality?.(Number(quality.value));
    const level = controller.getQuality?.() ?? 0;
    quality.value = String(level);
    qualityWrap.title = `Quality level — ${QUALITY_LEVELS[level]?.description ?? ""}`;
  });

  const fpsTimer = window.setInterval(() => {
    const current = controller.getFps?.() ?? null;
    if (current != null) fps.textContent = `${current} FPS`;
  }, 1000);

  wrap.append(label, select, qualityWrap, fps);
  qualityWrap.append(qualityLabel, quality);
  host.appendChild(wrap);

  return {
    el: wrap,
    destroy() {
      window.clearInterval(fpsTimer);
      if (wrap.parentNode === host) host.removeChild(wrap);
    },
  };
}