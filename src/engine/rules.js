/**
 * Pure rule-set engine for the 3D Game of Life.
 *
 * This module owns every rule concern that the simulation core and the rule
 * editor share, without touching the DOM or three.js:
 *
 *   - the canonical 26-neighbour Moore set used by pure-3D evaluation,
 *   - the built-in preset rule-sets (Conway, HighLife, Seeds, Day & Night,
 *     and a 3D-flavoured rule that needs the full 26-cell neighbourhood),
 *   - B/S notation parsing/serialization ("B3/S23", "B36/S23", "B2/S"),
 *     extended with A..Q digits so the 3D neighbour counts 10..26 stay
 *     expressible in one compact character,
 *   - a compact share code that round-trips a whole named rule-set through
 *     localStorage-free text the user can copy and paste on a fresh page.
 *
 * All functions here are deterministic and headless so engine tests and the
 * browser UI exercise exactly the same code path.
 */

import { createRuleSet, DEFAULT_RULE_SET, validateRuleSet } from "../contracts/ruleSet.js";

/** Maximum number of neighbours in the 3D Moore neighbourhood (3×3×3 minus self). */
export const NEIGHBOR_MAX = 26;

/** The full 26-cell Moore neighbourhood around a cell (every delta but (0,0,0)). */
export const NEIGHBORHOOD_3D = Object.freeze(
  (() => {
    const list = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          list.push([dx, dy, dz]);
        }
      }
    }
    return list;
  })(),
);

/** Built-in presets. Conway is the phase-1 contract default (B3/S23). */
export const PRESET_RULE_SETS = Object.freeze([
  DEFAULT_RULE_SET, // Conway B3/S23 — { id: "conway-b3s23", name: "Conway B3/S23 (3D)" }
  Object.freeze({
    id: "highlife",
    name: "HighLife B36/S23",
    mode: "conway",
    birth: [3, 6],
    survive: [2, 3],
  }),
  Object.freeze({
    id: "seeds",
    name: "Seeds B2/S",
    mode: "conway",
    birth: [2],
    survive: [],
  }),
  Object.freeze({
    id: "day-night",
    name: "Day & Night B3678/S34678",
    mode: "conway",
    birth: [3, 6, 7, 8],
    survive: [3, 4, 6, 7, 8],
  }),
  Object.freeze({
    id: "bays-3d",
    name: "Bays 3D Life B25/S45 (26-neighbour)",
    mode: "conway",
    birth: [2, 5],
    survive: [4, 5],
  }),
]);

/** True when `count` is a legal neighbour count (0..26). */
export function isValidNeighborCount(count) {
  return Number.isInteger(count) && count >= 0 && count <= NEIGHBOR_MAX;
}

/** Sort + de-duplicate an array of neighbour counts (stable, deterministic). */
export function normalizeCounts(counts) {
  if (!Array.isArray(counts)) return [];
  return [...new Set(counts)].filter(isValidNeighborCount).sort((a, b) => a - b);
}

/** One character per count: 0-9 stay digits, 10-26 map to A..Q. */
const COUNT_TO_CHAR = Object.freeze(
  Array.from({ length: NEIGHBOR_MAX + 1 }, (_, i) => (i <= 9 ? String(i) : String.fromCharCode(65 + i - 10))),
);

const CHAR_TO_COUNT = Object.freeze(
  Object.fromEntries(COUNT_TO_CHAR.map((ch, i) => [ch, i])),
);

/** Compact canonical string, e.g. "B3/S23", "B36/S23", "B2/S", "B25/S45". */
export function toRuleString(ruleSet) {
  const birth = normalizeCounts(ruleSet?.birth);
  const survive = normalizeCounts(ruleSet?.survive);
  return `B${birth.map((n) => COUNT_TO_CHAR[n]).join("")}/S${survive.map((n) => COUNT_TO_CHAR[n]).join("")}`;
}

/**
 * Parse B/S notation into `{ birth, survive }` neighbour-count arrays.
 *
 * Accepts "B3/S23", "b36/s23", "B2/S", "B3678/S34678" and the extended
 * 3D counts A..Q (A=10 … Q=26), e.g. "BAQ/S13" → birth [10, 26].
 *
 * @throws {TypeError} when the string is not a valid B/S rule.
 */
export function parseRuleString(raw) {
  if (typeof raw !== "string") throw new TypeError("rule string must be a string");
  const match = raw.trim().toUpperCase().match(/^B([0-9A-Q]*)\/?S([0-9A-Q]*)$/);
  if (!match) {
    throw new TypeError(
      `invalid rule string "${raw}" — expected B<counts>/S<counts>, e.g. "B3/S23" or "B25/S45"`,
    );
  }
  const decode = (chars) => [...chars].map((ch) => CHAR_TO_COUNT[ch]);
  const birth = normalizeCounts(decode(match[1]));
  const survive = normalizeCounts(decode(match[2]));
  return { birth, survive };
}

/** Convert a plain counts object into a validated, frozen rule-set. */
export function createRuleFromCounts(input = {}) {
  const rule = {
    id: input.id ?? `custom-${Date.now().toString(36)}`,
    name: input.name ?? "Custom",
    mode: input.mode ?? "life-like",
    birth: normalizeCounts(input.birth),
    survive: normalizeCounts(input.survive),
  };
  return createRuleSet(rule);
}

/** Structural equality of the transition (birth/survive), ignoring id/name. */
export function sameRule(a, b) {
  return toRuleString(a) === toRuleString(b);
}

/** Find a preset by id, or undefined. */
export function getPreset(id) {
  return PRESET_RULE_SETS.find((r) => r.id === id);
}

// ---- Compact share code ----------------------------------------------------

/** Prefix for the portable share code produced by `encodeRuleShare`. */
export const SHARE_PREFIX = "life3d:rule:";

function b64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const bin = atob(b64 + "=".repeat(pad));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a rule-set into a compact copy-paste string. The payload keeps the
 * name and transition counts so an import reproduces the same named rule.
 */
export function encodeRuleShare(ruleSet) {
  validateRuleSet(ruleSet);
  const payload = {
    v: 1,
    id: ruleSet.id,
    name: ruleSet.name,
    b: normalizeCounts(ruleSet.birth),
    s: normalizeCounts(ruleSet.survive),
  };
  return SHARE_PREFIX + b64UrlEncode(JSON.stringify(payload));
}

/**
 * Decode a share code (from `encodeRuleShare`) or a plain B/S string into a
 * validated rule-set. Accepts "B3/S23", "b36/s23", "life3d:rule:…", or the
 * bare base64 payload without the prefix. Throws on unusable input. */
export function decodeRuleShare(text) {
  if (typeof text !== "string") throw new TypeError("share code must be a string");
  const trimmed = text.trim();
  if (!trimmed) throw new TypeError("empty share code");
  const body = trimmed.startsWith(SHARE_PREFIX) ? trimmed.slice(SHARE_PREFIX.length) : trimmed;

  // Plain B/S notation is also a valid share code.
  if (/^B[0-9A-Qa-q]*\/?S[0-9A-Qa-q]*$/.test(body)) {
    const { birth, survive } = parseRuleString(body);
    return createRuleFromCounts({
      id: `imported-${toRuleString({ birth, survive }).toLowerCase().replace(/[^0-9a-z]/gi, "")}-${Date.now().toString(36)}`,
      name: `Imported ${toRuleString({ birth, survive })}`,
      mode: "life-like",
      birth,
      survive,
    });
  }

  let json;
  try {
    json = JSON.parse(b64UrlDecode(body));
  } catch {
    throw new TypeError(`could not decode share code "${trimmed.slice(0, 24)}…"`);
  }
  if (!json || json.v !== 1 || !Array.isArray(json.b) || !Array.isArray(json.s)) {
    throw new TypeError("share code payload is not a recognised life3d rule");
  }
  return createRuleFromCounts({
    id: json.id || `imported-${Date.now().toString(36)}`,
    name: json.name || `Imported ${toRuleString(json)}`,
    mode: json.mode ?? "life-like",
    birth: json.b,
    survive: json.s,
  });
}

export { DEFAULT_RULE_SET };