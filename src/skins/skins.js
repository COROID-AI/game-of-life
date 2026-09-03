/**
 * Visual skins / scene themes for the 3D Game of Life.
 *
 * This module is the skin registry consumed by the HUD skin selector and the
 * three.js renderer. Every entry is a superset of the phase-1 skin contract
 * (src/contracts/skin.js): `id`, `label`, `description`, `color`, `emissive`
 * and `background` are required and must pass `validateSkin` — no parallel
 * registration mechanism is introduced. On top of the base contract each skin
 * carries the renderer-side visual language:
 *
 *   - style        cell geometry/material family ("voxel" | "wireframe" | "organic")
 *   - backgroundTop gradient top color for the scene background
 *   - fog          { color, near, far } or null
 *   - grid         { color1, color2, axes } grid-floor line colors
 *   - lights       { ambient, key, fill } per-skin lighting rig
 *   - palette      { young, mid, old, dying } age/dying tint stops
 *   - cell         geometry hints ({ size, bloom? })
 *
 * The module is headless: no three.js or DOM imports, so it stays testable
 * under `node --test` and usable by any renderer.
 */

import { validateSkin } from "../contracts/index.js";

/** Id of the skin applied when no stored choice exists (matches the scaffold's Neon feel). */
export const DEFAULT_SKIN_ID = "neon-wireframe";

/** Cell geometry/material families the renderer knows how to build. */
export const SKIN_STYLES = Object.freeze(["voxel", "wireframe", "organic"]);

/** Palette keys every skin must define for age tinting and dying ghosts. */
export const SKIN_PALETTE_KEYS = Object.freeze(["young", "mid", "old", "dying"]);

/** Ordered built-in definitions (registered on module load). */
const SKIN_DEFINITIONS = Object.freeze([
  {
    id: "classic-voxels",
    label: "Classic Voxels",
    description: "Solid amber voxels with warm per-cell age tinting and soft fog.",
    color: "#ffd166",
    emissive: "#3a2400",
    background: "#101422",
    backgroundTop: "#1d2647",
    style: "voxel",
    fog: { color: "#0f1522", near: 26, far: 62 },
    grid: { color1: "#34415f", color2: "#1a2240", axes: "#46587f" },
    lights: {
      ambient: { color: "#ffffff", intensity: 0.62 },
      key: { color: "#fff3da", intensity: 1.25, position: [18, 30, 14] },
      fill: { color: "#7f9cff", intensity: 0.3, position: [-14, -8, -18] },
    },
    palette: { young: "#ff9a3c", mid: "#ffd166", old: "#fff3d6", dying: "#ff5a5f" },
    cell: { size: 0.78, bloom: false },
  },
  {
    id: "neon-wireframe",
    label: "Neon Wireframe",
    description: "Emissive wireframe cages with additive glow on a near-black void.",
    color: "#39ff14",
    emissive: "#003300",
    background: "#05070d",
    backgroundTop: "#0b1424",
    style: "wireframe",
    fog: { color: "#05070d", near: 24, far: 58 },
    grid: { color1: "#0e2b1c", color2: "#071a10", axes: "#14402a" },
    lights: {
      ambient: { color: "#0f2f1c", intensity: 0.55 },
      key: { color: "#39ff14", intensity: 0.9, position: [14, 24, 10] },
      fill: { color: "#1affd0", intensity: 0.35, position: [-16, -6, -18] },
    },
    palette: { young: "#1affd0", mid: "#39ff14", old: "#d2ff78", dying: "#ff3ea5" },
    cell: { size: 0.82, bloom: true },
  },
  {
    id: "organic",
    label: "Organic",
    description: "Rounded organic cells with soft material, ambient tint and gentle fog.",
    color: "#8fe0bb",
    emissive: "#12382c",
    background: "#0b1210",
    backgroundTop: "#15231e",
    style: "organic",
    fog: { color: "#0a100e", near: 20, far: 54 },
    grid: { color1: "#21423a", color2: "#12281f", axes: "#2c5546" },
    lights: {
      ambient: { color: "#c8ecdc", intensity: 0.8 },
      key: { color: "#fff0d2", intensity: 1.0, position: [20, 30, 14] },
      fill: { color: "#7fb4e9", intensity: 0.4, position: [-14, -8, -18] },
    },
    palette: { young: "#5fce9c", mid: "#8fe0bb", old: "#e2f8ec", dying: "#ff9f6e" },
    cell: { size: 0.8, bloom: false },
  },
]);

const registry = new Map();

/**
 * Validates the phase-1 skin contract PLUS the extended renderer fields this
 * registry requires. Base-field errors come from contracts/validateSkin.
 */
function validateSkinDefinition(def) {
  validateSkin(def); // phase-1 contract first (throws with its own messages)

  const issues = [];
  if (!SKIN_STYLES.includes(def.style)) {
    issues.push(`style must be one of ${SKIN_STYLES.join(", ")} (got ${def.style})`);
  }
  if (typeof def.backgroundTop !== "string" || def.backgroundTop.length === 0) {
    issues.push("backgroundTop must be a non-empty color string");
  }

  const palette = def.palette;
  if (!palette || typeof palette !== "object") {
    issues.push("palette must be an object with young/mid/old/dying");
  } else {
    for (const key of SKIN_PALETTE_KEYS) {
      if (typeof palette[key] !== "string" || palette[key].length === 0) {
        issues.push(`palette.${key} must be a non-empty color string`);
      }
    }
  }

  if (def.fog !== undefined && def.fog !== null) {
    const fog = def.fog;
    if (typeof fog.color !== "string" || fog.color.length === 0) {
      issues.push("fog.color must be a color string");
    }
    for (const key of ["near", "far"]) {
      if (!Number.isFinite(fog[key])) issues.push(`fog.${key} must be a finite number`);
    }
  }

  if (!def.grid || typeof def.grid !== "object") {
    issues.push("grid must be an object with color1/color2/axes");
  } else {
    for (const key of ["color1", "color2", "axes"]) {
      if (typeof def.grid[key] !== "string" || def.grid[key].length === 0) {
        issues.push(`grid.${key} must be a color string`);
      }
    }
  }

  const lights = def.lights;
  if (!lights || typeof lights !== "object") {
    issues.push("lights must be an object with ambient/key/fill");
  } else {
    for (const key of ["ambient", "key", "fill"]) {
      const light = lights[key];
      if (
        !light ||
        typeof light !== "object" ||
        typeof light.color !== "string" ||
        !Number.isFinite(light.intensity)
      ) {
        issues.push(`lights.${key} must be { color: string, intensity: number }`);
      }
    }
  }

  if (issues.length > 0) {
    throw new TypeError(`invalid skin definition: ${issues.join("; ")}`);
  }
}

/**
 * Register a skin definition. Throws on contract violations or duplicate ids.
 * Returns a frozen copy; the registry never hands out mutable entries.
 */
export function registerSkin(def) {
  validateSkinDefinition(def);
  if (registry.has(def.id)) {
    throw new Error(`skin already registered: ${def.id}`);
  }
  const frozen = Object.freeze({ ...def });
  registry.set(def.id, frozen);
  return frozen;
}

/** Look up a skin by id, or null when unknown. */
export function getSkin(id) {
  return registry.get(id) ?? null;
}

/** All registered skins in registration order. */
export function getSkins() {
  return [...registry.values()];
}

for (const definition of SKIN_DEFINITIONS) {
  registerSkin(definition);
}

/** Frozen snapshot of the built-in skins (registration order). */
export const SKINS = Object.freeze(getSkins());

/**
 * @typedef {Object} SkinDefinition Visual skin entry in the registry.
 * @property {string} id Unique stable identifier (presets / localStorage).
 * @property {string} label Human-readable name shown in the HUD.
 * @property {string} description One-line description / preview tooltip.
 * @property {string} color Base live-cell color (hex, contract field).
 * @property {string} emissive Base emissive color (hex, contract field).
 * @property {string} background Scene background base color (hex, contract field).
 * @property {"voxel"|"wireframe"|"organic"} style Cell geometry/material family.
 * @property {string} backgroundTop Gradient top color for the scene background.
 * @property {{color: string, near: number, far: number}|null} fog Scene fog.
 * @property {{color1: string, color2: string, axes: string}} grid Grid-floor colors.
 * @property {{ambient: {color:string,intensity:number}, key: ..., fill: ...}} lights Lighting rig.
 * @property {{young:string, mid:string, old:string, dying:string}} palette Age/dying tint stops.
 * @property {{size: number, bloom?: boolean}} cell Geometry hints.
 */