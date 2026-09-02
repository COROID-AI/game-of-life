#!/usr/bin/env node
/**
 * Lightweight WebSocket relay/signaling server for the 3D Game of Life
 * multiplayer rooms. `npm run relay` starts it on http://localhost:8787.
 *
 * The relay is deliberately stateless about simulation authority: it only
 * shuffles JSON between peers inside a room and keeps ONE cached
 * authoritative world snapshot per room (the latest full snapshot received
 * from the host, patched by host deltas when they arrive). It never ticks —
 * the deterministic phase-1 simulation lives entirely on the room HOST.
 *
 * Protocol (JSON over WebSocket):
 *   in : createRoom { name } | join { roomCode, name, worldSize }
 *        action { action } | presence { x, y, z } | snapshot { ... } | leave
 *   out: joined { peerId, roomCode, hostId, peers, snapshot?, actions?, worldSize }
 *        roster { peers, hostId } | action { action, sender }
 *        presence { sender, peer, x, y, z } | snapshot { ... }
 *        handoff { newHostId, snapshot?, actions?, worldSize }
 *        error { code, message }
 *
 * Deterministic host handoff: when the host disconnects, the relay picks the
 * oldest remaining peer (by join order), sends it the cached world snapshot
 * plus the tail of un-broadcast actions, and marks it as the new host. Every
 * client learns the handoff through the subsequent roster broadcast.
 */

import http from "node:http";
import crypto from "node:crypto";

import { WebSocketServer, WebSocket } from "ws";

import {
  MAX_GRID_SIZE,
  MAX_ROOM_CLIENTS,
  MAX_NAME_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_TICK_RATE,
  ACTION_RATE_LIMIT,
  normalizeRoomCode,
  isRoomCode,
  makeRoomCode,
  sanitizeName,
  validateAction,
  snapshotFromMap,
  cellsToKeyMap,
} from "../src/net/protocol.js";
import { validateWorldState } from "../src/contracts/index.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_SNAPSHOT_ACTIONS = 64; // action tail kept for late joiners / handoff

const rooms = new Map(); // roomCode -> { id, createdAt, peers: Map, snapshot, actions }
const clients = new Map(); // socket -> { id, room, name, joinedAt, actionTimes }

function log(...args) {
  const stamp = new Date().toISOString();
  console.log(`[relay ${stamp}]`, ...args);
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function peerRecord(client) {
  return {
    peerId: client.id,
    name: client.name,
    role: client.room.hostId === client.id ? "host" : "joiner",
    synced: true,
  };
}

function broadcast(room, message, except) {
  const payload = JSON.stringify(message);
  for (const client of room.peers.values()) {
    if (client === except) continue;
    if (client.socket.readyState === WebSocket.OPEN) {
      try {
        client.socket.send(payload);
      } catch {
        // cleanup happens on the socket close event
      }
    }
  }
}

function rosterMessage(room) {
  return {
    type: "roster",
    peers: [...room.peers.values()].map(peerRecord),
    hostId: room.hostId,
  };
}

/** Choose the next host deterministically: oldest joined peer. */
function pickNextHost(room) {
  const candidates = [...room.peers.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  return candidates[0] ?? null;
}

function createRoom(hostClient, name, requestedCode) {
  let code = requestedCode && isRoomCode(normalizeRoomCode(requestedCode))
    ? normalizeRoomCode(requestedCode)
    : makeRoomCode();
  let guard = 0;
  while (rooms.has(code) && guard < 50) {
    code = makeRoomCode();
    guard += 1;
  }
  const room = {
    id: code,
    createdAt: Date.now(),
    hostId: hostClient.id,
    peers: new Map([[hostClient.id, hostClient]]),
    snapshot: null,
    actions: [], // { sender, action } tail for late joiners / handoff
  };
  rooms.set(code, room);
  hostClient.room = room;
  hostClient.name = sanitizeName(name);
  hostClient.joinedAt = Date.now();
  log(`room ${code} created by ${hostClient.id} (${hostClient.name})`);
  return room;
}

function joinRoom(socket, message) {
  const code = normalizeRoomCode(message.roomCode ?? "");
  const room = rooms.get(code);
  if (!room) {
    send(socket, { type: "error", code: "room-not-found", message: `Room "${code}" does not exist` });
    return;
  }
  const worldSize = Number.isInteger(message.worldSize) ? message.worldSize : 16;
  if (worldSize > MAX_GRID_SIZE) {
    send(socket, {
      type: "error",
      code: "size-capped",
      message: `World size ${worldSize} exceeds the cap of ${MAX_GRID_SIZE}`,
    });
    return;
  }
  if (room.peers.size >= MAX_ROOM_CLIENTS) {
    send(socket, {
      type: "error",
      code: "room-full",
      message: `Room "${code}" already has ${MAX_ROOM_CLIENTS} players`,
    });
    return;
  }

  const client = clients.get(socket);
  client.room = room;
  client.name = sanitizeName(message.name ?? "");
  client.joinedAt = Date.now();
  room.peers.set(client.id, client);

  const isHost = room.hostId === client.id;
  const peers = [...room.peers.values()].map(peerRecord);
  send(socket, {
    type: "joined",
    peerId: client.id,
    roomCode: code,
    hostId: room.hostId,
    worldSize: room.snapshot?.size ?? worldSize,
    peers,
    snapshot: room.snapshot ?? undefined,
    actions: room.actions.slice(0, MAX_SNAPSHOT_ACTIONS),
    role: isHost ? "host" : "joiner",
  });

  const roster = rosterMessage(room);
  broadcast(room, roster, socket);
  log(`${client.id} (${client.name}) joined ${code} (${room.peers.size} players)`);
}

function hostEnsure(room) {
  if (room.peers.size === 0) {
    rooms.delete(room.id);
    return null;
  }
  if (room.hostId && room.peers.has(room.hostId)) return room;
  // Host left: deterministic handoff to the oldest remaining peer.
  const next = pickNextHost(room);
  room.hostId = next.id;
  log(`room ${room.id}: host disconnected, handing off to ${next.id} (${next.name})`);
  const handoff = {
    type: "handoff",
    newHostId: next.id,
    worldSize: room.snapshot?.size,
    snapshot: room.snapshot ?? undefined,
    actions: room.actions.slice(0, MAX_SNAPSHOT_ACTIONS),
  };
  send(next.socket, handoff);
  broadcast(room, rosterMessage(room));
  return room;
}

function handleAction(socket, message) {
  const client = clients.get(socket);
  const room = client?.room;
  if (!room) return;

  // Per-peer rate limit (sliding window).
  const nowMs = Date.now();
  client.actionTimes = (client.actionTimes ?? []).filter((t) => nowMs - t < 2000);
  if (client.actionTimes.length >= ACTION_RATE_LIMIT) {
    send(socket, { type: "error", code: "rate-limited", message: "Too many actions — slow down" });
    return;
  }
  client.actionTimes.push(nowMs);

  const half = Math.ceil((room.snapshot?.size ?? 16) / 2);
  let action;
  try {
    action = validateAction(message.action ?? {}, half);
  } catch (err) {
    send(socket, { type: "error", code: "invalid-action", message: err.message });
    return;
  }

  // Host-mediated: every client (including the originator) applies the same
  // frame. The relay echoes to the sender for instant feedback and forwards
  // joiner actions to the host, which is authoritative for the next snapshot.
  const frame = { sender: client.id, action };
  room.actions.push(frame);
  if (room.actions.length > MAX_SNAPSHOT_ACTIONS) room.actions.splice(0, room.actions.length - MAX_SNAPSHOT_ACTIONS);

  // Echo to the sender so the originator applies the action too (the relay
  // does not forward messages back via the host branch).
  send(socket, { type: "action", action, sender: client.id });

  if (room.hostId === client.id) {
    // The host is authoritative: rebroadcast to every other client so they
    // can preview within the same tick cycle.
    broadcast(room, { type: "action", action, sender: client.id }, socket);
  } else {
    // Forward to the host for validation + authoritative broadcast.
    const host = room.peers.get(room.hostId);
    if (host && host.socket.readyState === WebSocket.OPEN) {
      send(host.socket, { type: "action", action, sender: client.id });
    } else {
      // No host available (edge): try a handoff first, then replay.
      const fixed = hostEnsure(room);
      if (fixed) {
        const host2 = room.peers.get(room.hostId);
        if (host2) send(host2.socket, { type: "action", action, sender: client.id });
      }
    }
  }
}

function handlePresence(socket, message) {
  const client = clients.get(socket);
  const room = client?.room;
  if (!room) return;
  const x = Number.isFinite(message.x) ? message.x : 0;
  const y = Number.isFinite(message.y) ? message.y : 0;
  const z = Number.isFinite(message.z) ? message.z : 0;
  broadcast(room, { type: "presence", sender: client.id, peer: { id: client.id, name: client.name, color: undefined }, x, y, z }, socket);
}

function handleSnapshot(socket, message) {
  const client = clients.get(socket);
  const room = client?.room;
  if (!room || room.hostId !== client.id) return; // only the host may publish world
  let snapshot;
  try {
    snapshot = normalizeSnapshotMessage(message, room);
  } catch (err) {
    send(socket, { type: "error", code: "invalid-snapshot", message: err.message });
    return;
  }
  room.snapshot = snapshot;
  broadcast(room, { type: "snapshot", ...snapshot }, socket);
}

/** Convert a host snapshot message (full or delta) into a full world snapshot.
 *  Keeps the authoritative `rule` and `running` flags so a late join or a
 *  host handoff restores the exact transition + play/pause state. */
function normalizeSnapshotMessage(message, room) {
  const metaCarrier = {};
  if (message.running === true || message.running === false) metaCarrier.running = message.running;
  if (message.rule && typeof message.rule === "object") metaCarrier.rule = message.rule;

  let result;
  if (message.full === false && Array.isArray(message.changes)) {
    const base = cellsToKeyMap(room.snapshot ?? { cells: [] });
    for (const cell of message.changes) {
      const k = `${cell[0]},${cell[1]},${cell[2]}`;
      if (cell[3] === 1) base.set(k, 1);
      else base.delete(k);
    }
    const merged = snapshotFromMap(base, {
      generation: message.generation ?? room.snapshot?.generation ?? 0,
      size: message.size ?? room.snapshot?.size ?? 16,
    });
    merged.population = Number.isInteger(message.population) ? message.population : merged.cells.length;
    result = merged;
  } else {
    const full = {
      generation: message.generation ?? 0,
      size: message.size ?? 16,
      cells: Array.isArray(message.cells) ? message.cells : [],
    };
    validateWorldState(full);
    result = full;
  }
  if (Object.keys(metaCarrier).length > 0) {
    result = { ...result, ...metaCarrier };
  }
  validateWorldState(result);
  return result;
}

function handleLeave(socket) {
  const client = clients.get(socket);
  if (!client?.room) return;
  const room = client.room;
  room.peers.delete(client.id);
  client.room = null;
  broadcast(room, rosterMessage(room));
  hostEnsure(room);
  log(`${client.id} left ${room.id} (${room.peers.size} players)`);
}

// ---- HTTP + WebSocket ------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Game of Life 3D relay — WebSocket endpoint at /ws");
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MESSAGE_BYTES });

wss.on("connection", (socket) => {
  const client = {
    id: crypto.randomUUID(),
    name: "",
    room: null,
    joinedAt: 0,
    socket,
    actionTimes: [],
  };
  clients.set(socket, client);
  log(`client ${client.id} connected (${clients.size} online)`);

  socket.on("message", (data, isBinary) => {
    let message;
    try {
      const text = data.toString();
      if (text.length > MAX_MESSAGE_BYTES) throw new Error("message too large");
      message = JSON.parse(text);
    } catch (err) {
      send(socket, { type: "error", code: "bad-message", message: String(err?.message ?? "invalid JSON") });
      return;
    }
    switch (message?.type) {
      case "createRoom":
        createRoom(client, message.name ?? "", message.room ?? "");
        send(socket, {
          type: "joined",
          peerId: client.id,
          roomCode: client.room.id,
          hostId: client.room.hostId,
          worldSize: client.room.snapshot?.size ?? 16,
          peers: [...client.room.peers.values()].map(peerRecord),
          role: "host",
        });
        break;
      case "join":
        joinRoom(socket, message);
        break;
      case "action":
        handleAction(socket, message);
        break;
      case "presence":
        handlePresence(socket, message);
        break;
      case "snapshot":
        handleSnapshot(socket, message);
        break;
      case "leave":
        handleLeave(socket);
        socket.close(1000, "leave");
        break;
      default:
        send(socket, { type: "error", code: "unknown-message", message: `Unknown message type "${message?.type}"` });
    }
  });

  socket.on("close", () => {
    clients.delete(socket);
    if (client.room) {
      client.room.peers.delete(client.id);
      broadcast(client.room, rosterMessage(client.room));
      hostEnsure(client.room);
      log(`client ${client.id} disconnected (${clients.size} online)`);
    }
  });

  socket.on("error", (err) => {
    log(`socket error ${err.message}`);
  });
});

server.listen(PORT, HOST, () => {
  log(`relay listening on http://${HOST}:${PORT} (/ws)`);
  log(`health: http://localhost:${PORT}/health`);
});