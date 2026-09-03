/**
 * Skin/theme contract consumed by phase-2 skin tasks.
 *
 * A skin describes how a live cell is rendered. It is intentionally
 * engine-agnostic: the 3D renderer maps `color`/`emissive` straight onto
 * three.js materials, while `label`/`description` feed HUD and preset menus.
 */

export const DEFAULT_SKIN = Object.freeze({
  id: "default",
  label: "Neon",
  description: "Classic neon voxel lattice.",
  color: "#39ff14",
  emissive: "#003300",
  background: "#0a0e1a",
});

/** Throws a descriptive TypeError for any skin contract violation. */
export function validateSkin(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("skin must be an object");
  }
  const issues = [];
  for (const field of ["id", "label", "color", "background"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      issues.push(`${field} must be a non-empty string`);
    }
  }
  if (typeof value.description !== "string") {
    issues.push("description must be a string");
  }
  if (typeof value.emissive !== "string") {
    issues.push("emissive must be a string color");
  }
  if (issues.length > 0) {
    throw new TypeError(`invalid skin: ${issues.join("; ")}`);
  }
}

/** Structural guard for skin objects. */
export function isSkin(value) {
  try {
    validateSkin(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {Object} Skin Theme contract for the 3D scene and HUD.
 * @property {string} id Unique skin identifier (preset/multiplayer sync).
 * @property {string} label Human-readable name.
 * @property {string} description One-line description.
 * @property {string} color Live-cell base color (hex).
 * @property {string} emissive Live-cell emissive color (hex).
 * @property {string} background Scene/UI background color (hex).
 */