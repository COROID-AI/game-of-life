/**
 * Tests for the multiplayer session layer (src/net/protocol.js) and the
 * session message handling (src/net/session.js).
 *
 * These tests run headless under `node --test`. They exercise the pure
 * protocol helpers and drive the session's message handling through a fake
 * WebSocket so no browser or network is required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_GRID_SIZE,
  MAX_WORLD_CELLS,
  MAX_TICK_RATE,
  ROOM_CODE_LENGTH,
  ROOM_CODE_RE,
  makeRoomCode,
  normalizeRoomCode,
  isRoomCode,
  sanitizeName,
  peerColorFor,
  validateAction,
  compactAction,
  cellsToKeyMap,
  snapshotFromMap,
  diffSnapshots,
  mergeIntoSnapshot,
  estimateSnapshotSize,
} from "./protocol.js";

import { createSession, PEER_ROLE, SESSION_STATE } from "./session.js";
import { createSimulation } from "../engine/simulation.js";

// ---- protocol: room codes ------------------------------------------------

test("protocol: room codes are normalized and validated", () => {
  assert.equal(ROOM_CODE_LENGTH, 5);
  assert.match(makeRoomCode(), ROOM_CODE_RE);
  assert.equal(isRoomCode(makeRoomCode()), true);
  assert.equal(isRoomCode("abc"), false);
  assert.equal(isRoomCode("ABCDE"), true);
  assert.equal(normalizeRoomCode("  ab-cd e "), "ABCDE");
});

test("protocol: names are sanitized and bounded", () => {
  assert.equal(sanitizeName("  Alice   Smith  "), "Alice Smith");
  assert.equal(sanitizeName("<script>alert(1)</script>"), "scriptalert(1)script");
  assert.equal(sanitizeName("x".repeat(80)).length <= 24, true);
  assert.match(sanitizeName(""), /^Player\d{3}$/);
});

test("protocol: peer colors are stable and finite", () => {
  const c1 = peerColorFor("peer-a");
  const c2 = peerColorFor("peer-a");
  const c3 = peerColorFor("peer-b");
  assert.equal(c1, c2);
  assert.match(c1, /^#[0-9a-f]{6}$/i);
  assert.notEqual(c1, c3);
});

// ---- protocol: actions -----------------------------------------------------

test("protocol: validateAction accepts canonical actions", () => {
  assert.deepEqual(validateAction({ kind: "place", x: 1, y: 2, z: 3, alive: 1 }), { kind: "place", x: 1, y: 2, z: 3, alive: 1 });
  assert.deepEqual(validateAction({ kind: "pause" }), { kind: "pause" });
  assert.deepEqual(validateAction({ kind: "resume" }), { kind: "resume" });
  assert.deepEqual(validateAction({ kind: "step" }), { kind: "step" });
  assert.deepEqual(validateAction({ kind: "clear" }), { kind: "clear" });
  const rule = { id: "r", name: "R", mode: "conway", birth: [3], survive: [2, 3] };
  const out = validateAction({ kind: "rule", rule });
  assert.equal(out.kind, "rule");
  assert.deepEqual(out.rule, rule);
  assert.deepEqual(validateAction({ kind: "skin", skinId: "neon-wireframe" }), { kind: "skin", skinId: "neon-wireframe" });
});

test("protocol: validateAction rejects malformed actions", () => {
  assert.throws(() => validateAction({ kind: "place", x: 99, y: 0, z: 0, alive: 1 }), /x/);
  assert.throws(() => validateAction({ kind: "place", x: 0, y: 0, z: 0, alive: 5 }), /alive/);
  assert.throws(() => validateAction({ kind: "foo" }), /unknown action kind/);
  assert.throws(() => validateAction({ kind: "rule", rule: { id: "r", name: "R", mode: "conway", tick: () => {} } }), /cannot carry a custom function/);
});

test("protocol: compactAction preserves semantics", () => {
  assert.deepEqual(compactAction({ kind: "place", x: 1, y: 2, z: 3, alive: true }), { kind: "place", x: 1, y: 2, z: 3, alive: 1 });
  assert.deepEqual(compactAction({ kind: "skin", skinId: "organic" }), { kind: "skin", skinId: "organic" });
});

// ---- protocol: snapshot diff -----------------------------------------------

function makeSnapshot(gen, size, keys) {
  const cells = [...keys].map((k) => {
    const [x, y, z] = k.split(",").map(Number);
    return [x, y, z, 1];
  });
  return { generation: gen, size, population: cells.length, cells };
}

test("protocol: diffSnapshots computes sparse changes", () => {
  const prev = makeSnapshot(0, 16, ["0,0,0", "1,1,1"]);
  const next = makeSnapshot(1, 16, ["0,0,0", "2,2,2"]);
  const { changes } = diffSnapshots(prev, next);
  assert.deepEqual(changes, [[2, 2, 2, 1], [1, 1, 1, 0]]);
});

test("protocol: mergeIntoSnapshot applies changes onto a full base", () => {
  const base = makeSnapshot(0, 16, ["0,0,0", "1,1,1"]);
  const merged = mergeIntoSnapshot(base, {
    base: 0,
    changes: [[2, 2, 2, 1], [1, 1, 1, 0]],
  });
  const keys = cellsToKeyMap(merged);
  assert.equal(keys.has("0,0,0"), true);
  assert.equal(keys.has("1,1,1"), false);
  assert.equal(keys.has("2,2,2"), true);
});

test("protocol: snapshotFromMap / cellsToKeyMap round-trip", () => {
  const map = new Map([["0,0,0", 1], ["1,2,3", 1]]);
  const snap = snapshotFromMap(map, { generation: 5, size: 16 });
  assert.equal(snap.generation, 5);
  assert.equal(snap.cells.length, 2);
  const back = cellsToKeyMap(snap);
  assert.deepEqual([...back.keys()].sort(), ["0,0,0", "1,2,3"]);
});

test("protocol: estimateSnapshotSize bounds messages", () => {
  const size = estimateSnapshotSize({ cells: [[0, 0, 0, 1]] });
  assert.equal(typeof size, "number");
  assert.ok(size > 0);
});

// ---- session: message handling through a fake socket ------------------------

function fakeSocket() {
  const calls = [];
  let readyState = 1; // WebSocket.OPEN
  return {
    readyState,
    sent: calls,
    send(data) {
      calls.push(JSON.parse(data));
    },
    close() { this.readyState = 3; },
    get ready() { return readyState; },
  };
}

/** Build a session with a fake socket and drive handleMessage directly. */
function makeSession(handlers = {}) {
  const sim = createSimulation({ size: 16, seedDensity: 0 });
  const session = createSession(sim, handlers);
  const ws = fakeSocket();
  // Attach the socket manually (session uses window.WebSocket normally).
  session.__socket = ws;
  return { sim, session, ws };
}

test("session: joining applies the authoritative snapshot and roster", () => {
  const events = [];
  const { sim, session } = makeSession({
    onJoined: (e) => events.push(e),
    onSnapshot: (e) => events.push(["snap", e.generation]),
    onRoster: (e) => events.push(["roster", e.peers.length]),
  });
  const snap = makeSnapshot(3, 16, ["0,0,0", "5,5,5"]);
  session.__handleMessage?.({
    type: "joined",
    peerId: "p1",
    roomCode: "ABC12",
    hostId: "p1",
    peers: [{ peerId: "p1", name: "Alice", role: "host" }],
    snapshot: snap,
  });
  assert.equal(sim.generation, 3);
  assert.equal(session.getRoomCode(), "ABC12");
  assert.equal(session.isHost(), true);
});

test("session: snapshot messages restore the simulation (joiner path)", () => {
  const { sim, session } = makeSession();
  const snap = makeSnapshot(7, 16, ["1,1,1", "2,2,2"]);
  session.__handleMessage?.({ type: "snapshot", ...snap });
  assert.equal(sim.generation, 7);
  assert.equal(sim.population, 2);
});

test("session: rejects out-of-contract snapshots (oversized size / cells / coords)", () => {
  const { sim, session } = makeSession();
  const errors = [];
  const session2 = makeSession({ onError: (e) => errors.push(e) }).session;
  // Oversized size must be rejected and the existing simulation left intact.
  session2.__handleMessage?.({ type: "snapshot", generation: 0, size: 10_000, cells: [] });
  assert.equal(sim.size, 16, "rejected snapshot must not resize the sim");
  assert.ok(errors.length >= 1, "an onError should be surfaced for an out-of-contract snapshot");
  const first = errors[0];
  assert.equal(first.code, "invalid-snapshot");
  assert.match(first.message, /exceeds the cap/);
});

test("session: rejects oversized handoff snapshot (host-promotion path)", () => {
  const { sim, session } = makeSession();
  session.__handleMessage?.({
    type: "handoff",
    newHostId: "p2",
    worldSize: 16,
    snapshot: { generation: 0, size: 10_000, cells: [] },
  });
  assert.equal(sim.size, 16, "rejected handoff must not grow the sim");
  assert.equal(sim.generation, 0);
});

test("protocol: MAX_GRID_SIZE/MAX_WORLD_CELLS are shared and match the contracts layer", async () => {
  const contracts = await import("../contracts/simulation.js");
  assert.equal(MAX_GRID_SIZE, contracts.MAX_GRID_SIZE);
  assert.equal(MAX_WORLD_CELLS, contracts.MAX_WORLD_CELLS);
  assert.equal(MAX_WORLD_CELLS, MAX_GRID_SIZE ** 3);
});

test("session: create/join after leave is allowed and closes the old socket", () => {
  const realWS = globalThis.WebSocket;
  const createdSockets = [];
  class FakeWS {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWS.CONNECTING;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.sent = [];
      createdSockets.push(this);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = FakeWS.CLOSED;
    }
  }
  globalThis.WebSocket = FakeWS;
  try {
    const { sim, session } = makeSession({});
    // First create: opens socket #1 (CONNECTING).
    session.create({ name: "Alice" });
    const first = createdSockets[0];
    assert.equal(createdSockets.length, 1);
    first.readyState = FakeWS.OPEN; // pretend the connection is live

    // Create again while connected: old socket gets `leave`, closes, and a
    // fresh socket opens (state CONNECTING again).
    session.create({ name: "Alice" });
    assert.ok(first.sent.some((m) => m.type === "leave"), "leave should be sent when switching rooms");
    assert.equal(first.readyState, FakeWS.CLOSED, "old socket should be closed on room switch");
    assert.equal(session.getState(), "connecting");
    assert.equal(createdSockets.length, 2);

    // Leave, then create again from the same session (no page reload).
    const second = createdSockets[1];
    second.readyState = FakeWS.OPEN;
    session.leave();
    assert.equal(session.getState(), "left");
    assert.ok(second.sent.some((m) => m.type === "leave"), "leave() sends leave on the current socket");
    const ok = session.create({ name: "Alice" });
    assert.equal(ok, true, "create after leave must be allowed");
    assert.equal(session.getState(), "connecting");
    assert.equal(createdSockets.length, 3, "a fresh socket is opened for the new room");

    // Joining another room while connected also switches sockets cleanly.
    const third = createdSockets[2];
    third.readyState = FakeWS.OPEN;
    session.join({ code: "ZXCVB" });
    assert.equal(session.getState(), "connecting");
    assert.equal(createdSockets.length, 4, "join after connected also opens a fresh socket");
    assert.ok(third.sent.some((m) => m.type === "leave"), "join while connected also leaves cleanly");
  } finally {
    globalThis.WebSocket = realWS;
  }
});

test("session: host handoff restores the relay's world and promotes the peer", () => {
  const { sim, session } = makeSession();
  const snap = makeSnapshot(11, 16, ["3,3,3"]);
  session.__handleMessage?.({
    type: "handoff",
    newHostId: "p2",
    worldSize: 16,
    snapshot: snap,
  });
  assert.equal(sim.generation, 11);
  assert.equal(session.isHost(), true);
  assert.equal(session.getHost(), "p2");
});