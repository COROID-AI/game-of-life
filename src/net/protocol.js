/**
 * Multiplayer protocol contract for the 3D Game of Life.
 *
 * Pure, engine-agnostic wire helpers shared by the browser client
 * (src/net/session.js), the HUD, and the Node relay (server/relay.js).
 * No DOM, three.js, or network imports — everything here is deterministic
 * and testable headless under `node --test`.
 *
 * Message model (JSON over WebSocket):
 *
 *   client -> relay
 *     { type: "join",  roomCode, name, worldSize }
 *     { type: "action", action }                     // place/rule/skin/pause/...
 *     { type: "presence", x, y, z }                  // cursor marker
 *     { type: "snapshot", generation, size, population, running, rule,
 *       cells }                                      // host -> relay (authoritative)
 *     { type: "leave" }
 *
 *   relay -> client
 *     { type: "joined", peerId, roomCode, hostId, worldSize, peers,
 *       snapshot?, actions }
 *     { type: "roster", peers, hostId }
 *     { type: "action", action, sender }
 *     { type: "presence", sender, peer, x, y, z }
 *     { type: "snapshot", ... }                      // authority broadcast (full)
 *     { type: "handoff", newHostId, snapshot, actions, worldSize }
 *     { type: "error", message }
 *
 * World snapshots follow the phase-1 contract (contracts/worldState.js):
 * `{ generation, size, cells: [x, y, z, alive][] }`. `cells` lists live cells
 * only (alive === 1), so population === cells.length for a full snapshot.
 *
 * The relay keeps ONE authoritative world state per room (its latest full
 * snapshot, patched by host deltas) plus the tail of un-broadcast actions.
 * On join or host handoff it replays that state to the receiving client, so
 * every client starts from the same deterministic lattice.
 */

import { validateWorldState, isRuleSet } from "../contracts/index.js";
import { MAX_GRID_SIZE, MAX_WORLD_CELLS } from "../contracts/simulation.js";

// ---- Caps shared by client + server ---------------------------------------

/** Largest cubic lattice a room may carry (grid-size cap). Re-exported from
 *  the contracts layer so every consumer (grid presets, relay, validation)
 *  shares one constant instead of redefining it. */
export { MAX_GRID_SIZE, MAX_WORLD_CELLS };

/** Hard ceiling for the host tick/broadcast rate in ticks per second. */
export const MAX_TICK_RATE = 8;

/** Tick/broadcast rate used when the host does not override it. */
export const DEFAULT_TICK_RATE = 4;

/** Maximum peers allowed in one room. */
export const MAX_ROOM_CLIENTS = 8;

/** Maximum peer display-name length. */
export const MAX_NAME_LENGTH = 24;

/** Full snapshots are always used below this live-cell count. */
export const DELTA_THRESHOLD = 2048;

/** Maximum plain-text size for any incoming relay message (safety cap). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Maximum actions a peer may send inside a sliding 2 second window. */
export const ACTION_RATE_LIMIT = 40;

// ---- Room codes / share links ---------------------------------------------

/** Alphabet for shareable room codes (unambiguous when spoken/copied). */
export const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const ROOM_CODE_LENGTH = 5;

export const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_CHARS}]{${ROOM_CODE_LENGTH}}$`);

/** Generate a fresh room code (cryptographically random when available). */
export function makeRoomCode() {
  const picks = [];
  const rand = () => {
    const arr = new Uint32Array(1);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(arr);
      return arr[0] / 4294967296;
    }
    return Math.random();
  };
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    picks.push(ROOM_CODE_CHARS[Math.floor(rand() * ROOM_CODE_CHARS.length)]);
  }
  return picks.join("");
}

/** Normalise a user-typed code (strip spaces/hyphens, uppercase). */
export function normalizeRoomCode(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\s\-_]/g, "").toUpperCase();
}

/** True when a string is a usable room code. */
export function isRoomCode(value) {
  return ROOM_CODE_RE.test(value);
}

/** Join link for a room code, relative to the current origin. */
export function buildRoomLink(code, name) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  if (name) url.searchParams.set("name", name);
  url.hash = "";
  return url.toString();
}

/**
 * Parse `?room=CODE&name=Name` out of a location.search / URL string.
 * @returns {{ code: string, name: string }} normalized code (may be empty).
 */
export function parseRoomLink(search) {
  let params;
  try {
    params = new URLSearchParams(search);
  } catch {
    params = new URLSearchParams();
  }
  return {
    code: normalizeRoomCode(params.get("room") ?? ""),
    name: sanitizeName(params.get("name") ?? ""),
  };
}

/**
 * Bring a display name into a safe, bounded form used by room rosters.
 * Falls back to a generated alias when nothing usable remains.
 */
export function sanitizeName(raw) {
  const cleaned = String(raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/[<>{}[\]/\\]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  if (cleaned.length > 0) return cleaned;
  return `Player${Math.floor(100 + Math.random() * 900)}`;
}

// ---- Peer colors (deterministic per peer id) -------------------------------

export const PEER_COLORS = Object.freeze([
  "#39ff14", // neon green (default skin vibe)
  "#ff3ea5", // hot pink
  "#27b3ff", // sky blue
  "#ffd166", // amber
  "#b28dff", // violet
  "#3ddc97", // mint
  "#ff9f6e", // coral
  "#7fe0ff", // ice
]);

/** Deterministic marker color for a peer id (stable for roster + scene). */
export function peerColorFor(peerId) {
  let hash = 0;
  const s = String(peerId ?? "");
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return PEER_COLORS[hash % PEER_COLORS.length];
}

// ---- Action validation -----------------------------------------------------

/**
 * Validate a client action against the multiplayer contract.
 * @param {Object} action
 * @param {number} [half] Lattice half-extent for bounds-checking `place`.
 * @returns {Object} A frozen, canonical copy of the action.
 * @throws {TypeError} describing the first violation.
 */
export function validateAction(action, half = 8) {
  if (!action || typeof action !== "object") {
    throw new TypeError("action must be an object");
  }
  const kind = action.kind;
  if (typeof kind !== "string") {
    throw new TypeError("action.kind must be a string");
  }
  switch (kind) {
    case "place": {
      const { x, y, z, alive } = action;
      for (const [label, v] of [["x", x], ["y", y], ["z", z]]) {
        if (!Number.isInteger(v) || v < -half || v >= half) {
          throw new TypeError(`place ${label} must be an integer in [-${half}, ${half - 1}]`);
        }
      }
      if (alive !== 0 && alive !== 1 && alive !== true && alive !== false) {
        throw new TypeError("place alive must be 0 or 1");
      }
      return Object.freeze({ kind, x, y, z, alive: alive ? 1 : 0 });
    }
    case "pause":
    case "resume":
    case "step":
    case "clear": // host-only convenience: empty the lattice
      return Object.freeze({ kind });
    case "rule": {
      const rule = action.rule;
      if (!rule || typeof rule !== "object") {
        throw new TypeError("rule action requires a rule-set object");
      }
      // Custom `tick` functions cannot cross the wire; reject them explicitly.
      if (typeof rule.tick === "function") {
        throw new TypeError("rule action cannot carry a custom function");
      }
      if (!isRuleSet(rule)) {
        throw new TypeError("rule action does not satisfy the rule-set contract");
      }
      return Object.freeze({ kind, rule: Object.freeze({ ...rule }) });
    }
    case "skin": {
      if (typeof action.skinId !== "string" || action.skinId.length === 0) {
        throw new TypeError("skin action requires a non-empty skinId");
      }
      return Object.freeze({ kind, skinId: action.skinId });
    }
    default:
      throw new TypeError(`unknown action kind "${kind}"`);
  }
}

/** Compact action wire form (stable key order for logs/tests). */
export function compactAction(action) {
  const a = validateAction(action);
  if (a.kind === "place") return { kind: "place", x: a.x, y: a.y, z: a.z, alive: a.alive };
  if (a.kind === "rule") return { kind: "rule", rule: a.rule };
  if (a.kind === "skin") return { kind: "skin", skinId: a.skinId };
  return { kind: a.kind };
}

// ---- Snapshot diff / delta helpers -----------------------------------------

/** Build a Map of "x,y,z" -> 1 from a full world-state snapshot. */
export function cellsToKeyMap(snapshot) {
  const map = new Map();
  if (!snapshot || !Array.isArray(snapshot.cells)) return map;
  for (const cell of snapshot.cells) {
    if (cell[3] === 1) map.set(`${cell[0]},${cell[1]},${cell[2]}`, 1);
  }
  return map;
}

/** Build a full snapshot object from a live-key Map. */
export function snapshotFromMap(map, { generation, size, population } = {}) {
  const cells = [...map.keys()].map((k) => {
    const [x, y, z] = k.split(",").map(Number);
    return [x, y, z, 1];
  });
  return {
    generation: Number.isInteger(generation) ? generation : 0,
    size: Number.isInteger(size) ? size : 16,
    population: Number.isInteger(population) ? population : cells.length,
    cells,
  };
}

/**
 * Compute the sparse change list between two full snapshots.
 * Only live cells are broadcast, so a change of [x,y,z,0] marks a death and
 * [x,y,z,1] marks a birth/placement.
 * @returns { base, changes: Array<[x,y,z,0|1]> }
 */
export function diffSnapshots(prev, next) {
  const prevMap = cellsToKeyMap(prev);
  const nextMap = cellsToKeyMap(next);
  const changes = [];
  for (const k of nextMap.keys()) {
    if (!prevMap.has(k)) {
      const [x, y, z] = k.split(",").map(Number);
      changes.push([x, y, z, 1]);
    }
  }
  for (const k of prevMap.keys()) {
    if (!nextMap.has(k)) {
      const [x, y, z] = k.split(",").map(Number);
      changes.push([x, y, z, 0]);
    }
  }
  return { base: prev?.generation ?? 0, changes };
}

/**
 * Apply a sparse change list to a live-key Map in place.
 * @param {Map<string,1>} map
 * @param {Array<[x,y,z,0|1]>} changes
 */
export function applyChangesToMap(_map, changes) {
  for (const cell of changes) {
    const k = `${cell[0]},${cell[1]},${cell[2]}`;
    if (cell[3] === 1) _map.set(k, 1);
    else _map.delete(k);
  }
  return _map;
}

/**
 * Merge a sparse change list into a full snapshot object, returning a NEW
 * full snapshot (the receiving mirror / relay cache stays authoritative).
 * @param {Object} full Base full snapshot.
 * @param {Object} delta `{ base, changes, generation? }` — the wire delta.
 */
export function mergeIntoSnapshot(full, { base, changes, generation }) {
  validateWorldState(full);
  const map = cellsToKeyMap(full);
  applyChangesToMap(map, changes);
  const merged = snapshotFromMap(map, {
    generation: Number.isInteger(generation) ? generation : full.generation,
    size: full.size,
  });
  if (Number.isInteger(full.population)) merged.population = full.population;
  return merged;
}

/** Estimated JSON payload size (bytes) for a snapshot message frame. */
export function estimateSnapshotSize(payload) {
  try {
    return JSON.stringify(payload).length;
  } catch {
    return Infinity;
  }
}