/**
 * World/cell state shape consumed by the simulation core and later
 * multiplayer tasks.
 *
 * Every serializable snapshot follows this schema:
 *
 * ```json
 * {
 *   "generation": 0,
 *   "size": 16,
 *   "cells": [
 *     [x0, y0, z0, 1],
 *     [x1, y1, z1, 0],
 *     ...
 *   ]
 * }
 * ```
 */

export const WORLD_STATE_SCHEMA = Object.freeze({
  type: "object",
  required: ["generation", "size", "cells"],
  properties: {
    generation: { type: "integer", minimum: 0 },
    size: { type: "integer", minimum: 1 },
    cells: {
      type: "array",
      items: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        prefixItems: [
          { type: "integer" },
          { type: "integer" },
          { type: "integer" },
          { type: "integer", enum: [0, 1] },
        ],
      },
    },
  },
  additionalProperties: false,
});

/** Validates a world snapshot against the compact schema above. */
export function validateWorldState(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("world state must be an object");
  }
  if (!Number.isInteger(value.generation) || value.generation < 0) {
    throw new TypeError("world state generation must be a non-negative integer");
  }
  if (!Number.isInteger(value.size) || value.size < 1) {
    throw new TypeError("world state size must be a positive integer");
  }
  if (!Array.isArray(value.cells)) {
    throw new TypeError("world state cells must be an array");
  }
  for (const cell of value.cells) {
    if (!Array.isArray(cell) || cell.length !== 4) {
      throw new TypeError("each cell entry must be [x, y, z, alive]");
    }
    for (let i = 0; i < 3; i++) {
      if (!Number.isInteger(cell[i])) {
        throw new TypeError(`cell coordinate ${i} must be an integer`);
      }
    }
    if (cell[3] !== 0 && cell[3] !== 1) {
      throw new TypeError("cell alive flag must be 0 or 1");
    }
  }
}

/** Structural guard for world snapshots. */
export function isWorldState(value) {
  try {
    validateWorldState(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {Object} WorldState Serializable snapshot of a lattice.
 * @property {number} generation Tick count.
 * @property {number} size Lattice extent (cubic edge length).
 * @property {Array<[number, number, number, 0|1]>} cells Compact alive/dead list.
 */

/**
 * @typedef {Object} CellState
 * @property {number} x X coordinate in [-size, size-1].
 * @property {number} y Y coordinate in [-size, size-1].
 * @property {number} z Z coordinate in [-size, size-1].
 * @property {0|1} alive Cell state: 1 live, 0 dead.
 */