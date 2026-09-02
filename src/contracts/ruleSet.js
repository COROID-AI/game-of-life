/**
 * Rule-set contract consumed by phase-2 rule-set tasks.
 *
 * A rule-set fully determines the transition applied by the simulation core:
 * cells live/die per `birth`/`survive` neighbourhood counts, and any rule-set
 * may define an explicit `tick` that overrides internal Conway evaluation.
 *
 * Optional `plane`/`planeOffset` restrict evolution to a classic 2D plane
 * inside the 3D lattice (8 in-plane neighbours; only cells on that plane can
 * change) — see src/engine/simulation.js. This preserves the original 2D
 * demo's exact B3/S23 behaviour for classic patterns.
 *
 * This is a schema sketch (validators export the machine-readable shape and
 * tests assert the concrete invariants) so every later rule UI, preset, and
 * network message serializes and validates the same object.
 */

export const RULE_SET_SCHEMA = Object.freeze({
  type: "object",
  required: ["id", "name", "mode"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    mode: {
      type: "string",
      enum: ["conway", "life-like", "custom-function"],
    },
    birth: { type: "array", items: { type: "integer", minimum: 0, maximum: 26 } },
    survive: { type: "array", items: { type: "integer", minimum: 0, maximum: 26 } },
    plane: { type: ["string", "null"], enum: ["x", "y", "z", null] },
    planeOffset: { type: "integer" },
    tick: { type: ["function", "undefined"], description: "Optional custom transition" },
  },
  additionalProperties: false,
});

/**
 * Default B3/S23 rule-set, matching the classic 2D demo's Conway behaviour
 * extended naturally to the 3D 26-neighbour lattice.
 */
export const DEFAULT_RULE_SET = Object.freeze({
  id: "conway-b3s23",
  name: "Conway B3/S23 (3D)",
  mode: "conway",
  birth: [3],
  survive: [2, 3],
});

/** Native (Node >= 20, browsers >= 2022) deep-equality for tests and guards. */
const deepEqual = (a, b) =>
  JSON.stringify(normalizeRuleSet(a)) === JSON.stringify(normalizeRuleSet(b));

const normalizeRuleSet = (r) => ({
  id: r && r.id,
  name: r && r.name,
  mode: r && r.mode,
  birth: r && Array.isArray(r.birth) ? [...r.birth].sort((x, y) => x - y) : null,
  survive: r && Array.isArray(r.survive) ? [...r.survive].sort((x, y) => x - y) : null,
  plane: r && (r.plane ?? null),
  planeOffset: r && (Number.isInteger(r.planeOffset) ? r.planeOffset : 0),
});

/**
 * Create (or validate-and-freeze) a rule-set object.
 * @param {Partial<RuleSet>} input `{ id, name, mode, birth, survive, tick?, plane?, planeOffset? }`
 * @returns {Readonly<RuleSet>} validated, frozen rule-set
 * @throws {TypeError} when the input does not satisfy the rule-set schema
 */
export function createRuleSet(input) {
  const rule = { ...input, id: input?.id ?? "custom", name: input?.name ?? "Custom" };
  validateRuleSet(rule);
  return Object.freeze(rule);
}

/** Compact wire form used by presets and network messages. */
export function compactRuleSet(ruleSet) {
  return {
    id: ruleSet.id,
    name: ruleSet.name,
    mode: ruleSet.mode,
    birth: ruleSet.birth ? [...ruleSet.birth] : [],
    survive: ruleSet.survive ? [...ruleSet.survive] : [],
    plane: ruleSet.plane ?? null,
    planeOffset: Number.isInteger(ruleSet.planeOffset) ? ruleSet.planeOffset : 0,
  };
}

/** Structural equality guard for rule-sets. */
export function isRuleSet(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string") return false;
  try {
    validateRuleSet(value);
    return deepEqual(value, normalizeRuleSet(value));
  } catch {
    return false;
  }
}

/** Throws a descriptive TypeError listing every schema violation. */
export function validateRuleSet(value) {
  const errors = [];
  if (!value || typeof value !== "object") {
    throw new TypeError("rule-set must be an object");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    errors.push("id must be a non-empty string");
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    errors.push("name must be a non-empty string");
  }
  if (value.mode !== "conway" && value.mode !== "life-like" && value.mode !== "custom-function") {
    errors.push(`mode must be one of "conway", "life-like", "custom-function" (got ${value.mode})`);
  }
  for (const field of ["birth", "survive"]) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      errors.push(`${field} must be an array of neighbourhood counts`);
    } else if (Array.isArray(value[field])) {
      for (const n of value[field]) {
        if (!Number.isInteger(n) || n < 0 || n > 26) {
          errors.push(`${field} entries must be integers from 0..26 (got ${n})`);
        }
      }
    }
  }
  if (value.plane !== undefined && value.plane !== null) {
    if (value.plane !== "x" && value.plane !== "y" && value.plane !== "z") {
      errors.push(`plane must be "x", "y", "z", or null (got ${value.plane})`);
    }
  }
  if (value.planeOffset !== undefined && !Number.isInteger(value.planeOffset)) {
    errors.push("planeOffset must be an integer when provided");
  }
  if (value.tick !== undefined && typeof value.tick !== "function") {
    errors.push("tick must be a function when provided");
  }
  if (errors.length > 0) {
    throw new TypeError(`invalid rule-set: ${errors.join("; ")}`);
  }
}

/**
 * @typedef {Object} RuleSet Contract for the active transition rules.
 * @property {string} id Unique stable identifier for presets/multiplayer sync.
 * @property {string} name Human-readable label.
 * @property {"conway"|"life-like"|"custom-function"} mode Transition family.
 * @property {number[]} [birth] Neighbour counts that birth a dead cell.
 * @property {number[]} [survive] Neighbour counts that keep a live cell alive.
 * @property {"x"|"y"|"z"|null} [plane] Optional plane constraint for classic 2D patterns.
 * @property {number} [planeOffset] Coordinate of the constrained plane.
 * @property {(world, getCell) => void} [tick] Custom transition; overrides defaults.
 */