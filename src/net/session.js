/**
 * Multiplayer session layer for the 3D Game of Life (authoritative-host sync).
 *
 * `createSession` wraps the phase-1 deterministic simulation and the shared
 * contracts with a room abstraction over a lightweight WebSocket relay. The
 * relay (server/relay.js, `npm run relay`) only shuffles JSON between peers —
 * all simulation authority lives in the room HOST.
 *
 * The module is browser-first (uses `WebSocket`, `window`, `performance`)
 * but keeps every protocol concern in pure helpers (src/net/protocol.js), so
 * headless tests can exercise message handling through a fake socket.
 */

import {
  validateAction,
  normalizeRoomCode,
  isRoomCode,
  makeRoomCode,
  buildRoomLink,
  parseRoomLink,
  sanitizeName,
  peerColorFor,
  diffSnapshots,
  DELTA_THRESHOLD,
} from "./protocol.js";
import { MAX_TICK_RATE } from "./protocol.js";

/** Roles a peer holds in a room session. */
export const PEER_ROLE = Object.freeze({ HOST: "host", JOINER: "joiner" });

/** Session lifecycle states. */
export const SESSION_STATE = Object.freeze({
  BOOTING: "booting",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  JOINED: "joined",
  HOST: "host",
  LEFT: "left",
  ERROR: "error",
});

function now() {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Create a multiplayer session attached to one simulation handle.
 *
 * @param {Object} sim Simulation handle from src/engine/simulation.js
 * @param {Object} [handlers] Optional callbacks (onRoster, onSnapshot,
 *   onAction, onPresence, onHandoff, onState, onError, onTick, onJoined).
 * @returns {Object} Session handle.
 */
export function createSession(sim, handlers = {}) {
  if (!sim || typeof sim.toSnapshot !== "function" || typeof sim.tick !== "function") {
    throw new TypeError("createSession requires a simulation handle");
  }

  // ---- Identity ------------------------------------------------------------
  let peerId = null;
  let roomCode = "";
  let displayName = "";
  let kind = "create"; // "create" | "join"

  let socket = null;
  let connectUrl = "";
  let retryTimer = null;
  let retryCount = 0;
  let manualClose = false;

  let state = SESSION_STATE.BOOTING;
  let hostId = null;
  let ownRole = PEER_ROLE.JOINER;
  let roster = []; // [{ peerId, name, role, synced }]
  let lastSnapshot = null;
  let queuedActions = [];

  // Host authority state (only meaningful when ownRole === HOST).
  let hostRule = null;
  let hostRunning = true;
  let hostTickRate = 4;
  let hostTickReference = 0;
  let lastPresenceSent = 0;
  // Latest authoritative running flag (from host snapshots; joiners use it).
  let roomRunning = true;

  const notify = (name, payload) => {
    if (typeof handlers[name] === "function") {
      try {
        handlers[name](payload);
      } catch (err) {
        console.error(`session handler "${name}" threw:`, err);
      }
    }
  };

  function setState(next) {
    if (state === next) return;
    state = next;
    notify("onState", { state, roomCode, peerId, role: ownRole, hostId });
  }

  function updateRoster(nextPeers, nextHostId) {
    roster = Array.isArray(nextPeers) ? nextPeers : [];
    if (typeof nextHostId === "string") hostId = nextHostId;
    const me = roster.find((p) => p.peerId === peerId);
    const isHost = hostId === peerId;
    if (me && isHost) {
      ownRole = PEER_ROLE.HOST;
      setState(SESSION_STATE.HOST);
    } else if (me) {
      ownRole = PEER_ROLE.JOINER;
      setState(SESSION_STATE.JOINED);
    }
    notify("onRoster", { peers: roster, hostId, role: ownRole });
  }

  // ---- Network -------------------------------------------------------------

  function isConnected() {
    return socket && socket.readyState === (typeof WebSocket !== "undefined" ? WebSocket.OPEN : 1);
  }

  function send(message) {
    if (!isConnected()) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.error("session send failed:", err);
      return false;
    }
  }

  function openSocket(url) {
    connectUrl = url;
    setState(SESSION_STATE.CONNECTING);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      notify("onError", { code: "socket-error", message: String(err?.message ?? err) });
      setState(SESSION_STATE.ERROR);
      return;
    }
    socket = ws;
    ws.onopen = () => {
      retryCount = 0;
      if (kind === "create") send({ type: "createRoom", name: displayName, room: roomCode });
      else send({ type: "join", roomCode, name: displayName, worldSize: sim.size });
    };
    ws.onmessage = (event) => {
      let message;
      try {
        message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        console.warn("session: dropped non-JSON message");
        return;
      }
      handleMessage(message);
    };
    ws.onclose = () => {
      socket = null;
      if (manualClose) {
        setState(SESSION_STATE.LEFT);
        return;
      }
      if (state === SESSION_STATE.LEFT || state === SESSION_STATE.ERROR) return;
      notify("onError", { code: "disconnected", message: "Connection to the relay was lost" });
      scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose always follows
    };
  }

  function scheduleReconnect() {
    if (retryTimer || manualClose) return;
    if (retryCount >= 5) {
      setState(SESSION_STATE.ERROR);
      return;
    }
    retryCount += 1;
    const delay = 500 * retryCount;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (manualClose) return;
      openSocket(connectUrl);
    }, delay);
  }

  function closeSocket(reason) {
    manualClose = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (socket) {
      const ws = socket;
      socket = null;
      try {
        ws.onopen = null;
        ws.onmessage = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, reason ?? "client leave");
        }
      } catch {
        // already closed
      }
    }
    setState(SESSION_STATE.LEFT);
  }

  // ---- Message handling ----------------------------------------------------

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "joined": {
        peerId = message.peerId;
        roomCode = message.roomCode;
        hostId = message.hostId ?? null;
        ownRole = hostId === peerId ? PEER_ROLE.HOST : PEER_ROLE.JOINER;
        roster = Array.isArray(message.peers) ? message.peers : [];
        if (message.snapshot) {
          lastSnapshot = message.snapshot;
          if (typeof message.snapshot.running === "boolean") roomRunning = message.snapshot.running;
          if (message.snapshot.rule) hostRule = message.snapshot.rule;
          try {
            sim.fromSnapshot(message.snapshot);
            notify("onSnapshot", message.snapshot);
          } catch (err) {
            console.error("session: could not apply join snapshot", err);
          }
        }
        for (const action of message.actions ?? []) {
          applyAction(action, { silent: true });
        }
        notify("onRoster", { peers: roster, hostId, role: ownRole });
        setState(ownRole === PEER_ROLE.HOST ? SESSION_STATE.HOST : SESSION_STATE.JOINED);
        notify("onJoined", { peerId, roomCode, hostId, role: ownRole });
        flushQueuedActions();
        break;
      }

      case "roster": {
        updateRoster(message.peers, message.hostId);
        break;
      }

      case "action": {
        applyAction(message.action, { sender: message.sender });
        break;
      }

      case "presence": {
        notify("onPresence", {
          sender: message.sender,
          peer: message.peer ?? message.sender,
          x: message.x,
          y: message.y,
          z: message.z,
        });
        break;
      }

      case "snapshot": {
        if (message.running === false) roomRunning = false;
        else if (message.running === true) roomRunning = true;
        acceptSnapshot(message);
        break;
      }

      case "handoff": {
        hostId = message.newHostId ?? hostId;
        if (message.snapshot) {
          if (message.snapshot.rule) hostRule = message.snapshot.rule;
          if (typeof message.snapshot.running === "boolean") {
            hostRunning = message.snapshot.running;
            roomRunning = hostRunning;
          }
          restoreSnapshot(message.snapshot);
        }
        for (const action of message.actions ?? []) {
          applyAction(action, { silent: true });
        }
        const nextWorldSize = message.worldSize ?? sim.size;
        ownRole = PEER_ROLE.HOST;
        setState(SESSION_STATE.HOST);
        notify("onHandoff", { newHostId: message.newHostId, worldSize: nextWorldSize });
        break;
      }

      case "error": {
        notify("onError", {
          code: message.code ?? "relay",
          message: message.message ?? "relay error",
        });
        break;
      }

      default:
        break;
    }
  }

  function flushQueuedActions() {
    const pending = queuedActions;
    queuedActions = [];
    for (const message of pending) {
      if (isConnected()) send(message);
    }
  }

  /** Apply a broadcast action (mediated by the host). */
  function applyAction(action, { sender = null, silent = false } = {}) {
    let canonical;
    try {
      canonical = validateAction(action, Math.ceil(sim.size / 2));
    } catch (err) {
      console.warn("session: ignoring invalid action", err.message);
      return;
    }
    if (!silent) notify("onAction", { action: canonical, sender });
    switch (canonical.kind) {
      case "place":
        sim.setCell(canonical.x, canonical.y, canonical.z, canonical.alive === 1);
        break;
      case "rule":
        hostRule = canonical.rule;
        break;
      // Host control actions: the host is authoritative; joiners just surface
      // them via onAction (the running flag comes with the next snapshot).
      case "pause":
        if (ownRole === PEER_ROLE.HOST) hostRunning = false;
        roomRunning = false;
        break;
      case "resume":
        if (ownRole === PEER_ROLE.HOST) hostRunning = true;
        roomRunning = true;
        break;
      case "step":
        if (ownRole === PEER_ROLE.HOST) {
          const rule = hostRule ?? sim.getActiveRule?.() ?? null;
          sim.tick(rule ?? undefined);
          const snapshot = sim.toSnapshot();
          snapshot.population = sim.population;
          broadcastSnapshot(snapshot);
        }
        break;
      case "clear":
        if (ownRole === PEER_ROLE.HOST) {
          sim.clear?.();
          const snapshot = sim.toSnapshot();
          snapshot.population = 0;
          broadcastSnapshot(snapshot);
        }
        break;
      case "skin":
        break;
    }
    if (!silent) {
      notify("onTick", {
        generation: sim.generation,
        population: sim.population,
        running: roomRunning,
      });
    }
  }

  // ---- Snapshot handling ---------------------------------------------------

  function mapFromSnapshot(snapshot) {
    const map = new Map();
    if (!snapshot || !Array.isArray(snapshot.cells)) return map;
    for (const cell of snapshot.cells) {
      if (cell && cell[3] === 1) map.set(`${cell[0]},${cell[1]},${cell[2]}`, 1);
    }
    return map;
  }

  /** Normalize a wire snapshot (full or delta) into a full world-state. */
  function normalizeSnapshot(message) {
    if (message.full === false && Array.isArray(message.changes)) {
      const base = mapFromSnapshot(lastSnapshot);
      for (const cell of message.changes) {
        const k = `${cell[0]},${cell[1]},${cell[2]}`;
        if (cell[3] === 1) base.set(k, 1);
        else base.delete(k);
      }
      const cells = [];
      for (const k of base.keys()) {
        cells.push([...k.split(",").map(Number), 1]);
      }
      return {
        generation: message.generation ?? 0,
        size: message.size ?? sim.size,
        population: message.population ?? cells.length,
        cells,
      };
    }
    return {
      generation: message.generation ?? 0,
      size: message.size ?? sim.size,
      population: message.population ?? (Array.isArray(message.cells) ? message.cells.length : 0),
      cells: Array.isArray(message.cells) ? message.cells : [],
    };
  }

  function acceptSnapshot(message) {
    const snapshot = normalizeSnapshot(message);
    lastSnapshot = snapshot;
    if (typeof message.running === "boolean") roomRunning = message.running;
    try {
      sim.fromSnapshot(snapshot);
      notify("onSnapshot", snapshot);
      notify("onTick", {
        generation: sim.generation,
        population: sim.population,
        running: roomRunning,
      });
    } catch (err) {
      console.error("session: could not apply snapshot", err);
    }
  }

  /** Restore an authoritative full snapshot into the hosted simulation. */
  function restoreSnapshot(snapshot) {
    if (!snapshot) return false;
    try {
      sim.fromSnapshot(snapshot);
      lastSnapshot = snapshot;
      notify("onSnapshot", snapshot);
      return true;
    } catch (err) {
      console.error("session: restoreSnapshot failed", err);
      return false;
    }
  }

  // ---- Host loop -----------------------------------------------------------

  function hostStep() {
    if (ownRole !== PEER_ROLE.HOST) return;
    let changed = false;
    if (hostRunning) {
      const rule = hostRule ?? sim.getActiveRule?.() ?? null;
      sim.tick(rule ?? undefined);
      changed = true;
    }
    if (!changed) return;
    roomRunning = hostRunning;
    const snapshot = sim.toSnapshot();
    snapshot.population = sim.population;
    if (hostRule) snapshot.rule = hostRule;
    broadcastSnapshot(snapshot);
    notify("onTick", {
      generation: sim.generation,
      population: sim.population,
      running: hostRunning,
    });
  }

  /** Broadcast the hosted world: sparse delta for large lattices, else full. */
  function broadcastSnapshot(snapshot) {
    const large = snapshot.cells.length > DELTA_THRESHOLD;
    let payload;
    if (large && lastSnapshot && lastSnapshot.generation <= snapshot.generation) {
      const { changes } = diffSnapshots(lastSnapshot, snapshot);
      payload = {
        type: "snapshot",
        full: false,
        changes,
        generation: snapshot.generation,
        size: snapshot.size,
        population: snapshot.population,
        running: hostRunning,
      };
      if (snapshot.rule) payload.rule = snapshot.rule;
    } else {
      payload = {
        type: "snapshot",
        full: true,
        generation: snapshot.generation,
        size: snapshot.size,
        population: snapshot.population,
        cells: snapshot.cells,
        running: hostRunning,
      };
      if (snapshot.rule) payload.rule = snapshot.rule;
    }
    lastSnapshot = snapshot;
    send({ type: "snapshot", ...payload });
  }

  /** Advance the room simulation on the host; no-op for joiners. */
  function tick(options = {}) {
    if (ownRole !== PEER_ROLE.HOST) return false;
    if (!options.force) {
      const interval = 1000 / hostTickRate;
      const elapsed = now() - hostTickReference;
      if (elapsed < interval * 0.9) return false;
    }
    hostTickReference = now();
    hostStep();
    return true;
  }

  /** Report the local cursor position to the room (~10 Hz). */
  function sendPresence(pos) {
    if (ownRole !== PEER_ROLE.HOST && ownRole !== PEER_ROLE.JOINER) return;
    const time = now();
    if (time - lastPresenceSent < 100) return;
    lastPresenceSent = time;
    send({ type: "presence", x: pos.x, y: pos.y, z: pos.z });
  }

  // ---- Public actions ------------------------------------------------------

  /** Place/seed a cell (host-mediated). */
  function requestPlace(x, y, z, alive) {
    requestAction({ kind: "place", x, y, z, alive: alive ? 1 : 0 });
  }

  /** Pause the hosted simulation. */
  function requestPause() {
    requestAction({ kind: "pause" });
  }

  /** Resume the hosted simulation. */
  function requestResume() {
    requestAction({ kind: "resume" });
  }

  /** Request an immediate single step from the host. */
  function requestStep() {
    requestAction({ kind: "step" });
  }

  /** Request the host to clear the lattice. */
  function requestClear() {
    requestAction({ kind: "clear" });
  }

  /** Request a rule-set switch. */
  function requestRule(ruleSet) {
    requestAction({ kind: "rule", rule: ruleSet });
  }

  /** Request a skin switch. */
  function requestSkin(skinId) {
    requestAction({ kind: "skin", skinId });
  }

  /** Send a mediated action; queues while connecting. */
  function requestAction(action) {
    let canonical;
    try {
      canonical = validateAction(action, Math.ceil(sim.size / 2));
    } catch (err) {
      notify("onError", { code: "invalid-action", message: err.message });
      return false;
    }
    const c = { kind: canonical.kind };
    if (c.kind === "place") {
      c.x = canonical.x;
      c.y = canonical.y;
      c.z = canonical.z;
      c.alive = canonical.alive;
    } else if (c.kind === "rule") {
      c.rule = canonical.rule;
    } else if (c.kind === "skin") {
      c.skinId = canonical.skinId;
    }
    const message = { type: "action", action: c };
    if (isConnected()) return send(message);
    queuedActions.push(message);
    return true;
  }

  // ---- Room lifecycle -------------------------------------------------------

  function relayUrlFromOptions(options) {
    if (options.relayUrl) return options.relayUrl;
    if (typeof window !== "undefined") {
      // Allow `?relay=ws://host:port/ws` so E2E can point the app at a
      // relay running on a different port than the Vite server.
      try {
        const relay = new URLSearchParams(window.location.search).get("relay");
        if (relay) return relay;
      } catch {
        // ignore malformed query
      }
      return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
    }
    return "ws://localhost:8787/ws";
  }

  /** Create a room on the relay. */
  function create(options = {}, onCreated) {
    if (manualClose) return false;
    kind = "create";
    displayName = sanitizeName(options.name ?? "");
    const code = normalizeRoomCode(options.room ?? "");
    roomCode = isRoomCode(code) ? code : makeRoomCode();
    connectUrl = relayUrlFromOptions(options);
    manualClose = false;
    openSocket(connectUrl);
    if (typeof onCreated === "function") {
      setTimeout(() => {
        onCreated({ roomCode, link: buildRoomLink(roomCode, displayName) });
      }, 0);
    }
    return true;
  }

  /** Join an existing room by code or link. */
  function join(options = {}) {
    if (manualClose) return false;
    let code = normalizeRoomCode(options.code ?? "");
    let name = sanitizeName(options.name ?? "");
    if (options.link && !code) {
      try {
        const parsed = parseRoomLink(new URL(options.link).search);
        code = normalizeRoomCode(parsed.code ?? "");
        name = name || parsed.name;
      } catch {
        // not a URL
      }
    }
    if (!isRoomCode(code)) {
      notify("onError", { code: "invalid-room", message: `"${code || "(empty)"}" is not a valid room code` });
      return false;
    }
    kind = "join";
    roomCode = code;
    displayName = name || sanitizeName("");
    connectUrl = relayUrlFromOptions(options);
    manualClose = false;
    openSocket(connectUrl);
    return true;
  }

  /** Leave the room and close the connection. */
  function leave() {
    if (isConnected()) send({ type: "leave" });
    closeSocket("user leave");
    return true;
  }

  function getState() {
    return state;
  }

  function getName() {
    return displayName;
  }

  function localColor() {
    return peerColorFor(peerId ?? "local");
  }

  function getRoster() {
    return roster;
  }

  function getLastSnapshot() {
    return lastSnapshot;
  }

  /** Latest authoritative running flag (host decides; joiners follow). */
  function isRoomRunning() {
    return roomRunning;
  }

  /** Set the host's active rule-set (used for host ticks; not broadcast). */
  function setHostRule(ruleSet) {
    hostRule = ruleSet && typeof ruleSet === "object" ? ruleSet : null;
    return hostRule;
  }

  /** Host-only: force-broadcast the current world immediately. */
  function sendSnapshotNow() {
    if (ownRole !== PEER_ROLE.HOST) return false;
    const snapshot = sim.toSnapshot();
    snapshot.population = sim.population;
    broadcastSnapshot(snapshot);
    return true;
  }

  function getHost() {
    return hostId;
  }

  function getPeerId() {
    return peerId;
  }

  function isHost() {
    return ownRole === PEER_ROLE.HOST;
  }

  function getTickRate() {
    return hostTickRate;
  }

  function setTickRate(rate) {
    hostTickRate = clamp(Number.isFinite(rate) ? rate : 4, 1, MAX_TICK_RATE);
    return hostTickRate;
  }

  function clampCell(x, y, z) {
    const half = Math.ceil(sim.size / 2);
    return {
      x: clamp(Math.round(x), -half, half - 1),
      y: clamp(Math.round(y), -half, half - 1),
      z: clamp(Math.round(z), -half, half - 1),
    };  }

  function getSim() {
    return sim;
  }

  return {
    create,
    join,
    leave,
    requestAction,
    requestPlace,
    requestPause,
    requestResume,
    requestStep,
    requestClear,
    requestRule,
    requestSkin,
    tick,
    sendPresence,
    restoreSnapshot,
    getState,
    getRole: () => ownRole,
    getName,
    getPeerId,
    getRoomCode: () => roomCode,
    getHost,
    getRoster: getRoster,
    isHost,
    getSim,
    getLastSnapshot,
    isRoomRunning,
    sendSnapshotNow,
    setHostRule,
    getTickRate,
    setTickRate,
    clampCell,
    localColor,
    // Test hook (fake-socket message driving, no public network).
    __handleMessage: handleMessage,
    get role() { return ownRole; },
    get state() { return state; },
    get roomCode() { return roomCode; },
    get peerId() { return peerId; },
    get hostId() { return hostId; },
  };
}