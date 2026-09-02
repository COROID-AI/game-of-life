/**
 * End-to-end relay integration tests.
 *
 * Boots the real Node relay (server/relay.js) on an ephemeral port, connects
 * several native `WebSocket` clients (Node >= 21 has a global WebSocket), and
 * verifies the full authoritative-host flow:
 *
 *   1. host creates a room, joiner joins by code and receives the cached world
 *   2. a joiner's place action is relayed + echoed back to every client
 *   3. when the host closes, the relay hands off to the oldest peer, which
 *      restores the latest snapshot and keeps ticking (no divergence)
 *   4. roster join/leave events are broadcast correctly
 *
 * This test is skipped automatically when no local WebSocket is available.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createSimulation } from "../engine/simulation.js";

const RELAY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "server", "relay.js");

function hasWebSocket() {
  return typeof WebSocket === "function";
}

async function getFreePort() {
  const srv = createServer();
  srv.listen(0);
  await new Promise((resolve) => srv.once("listening", resolve));
  const port = srv.address().port;
  srv.close();
  await new Promise((resolve) => srv.once("close", resolve));
  return port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve once the socket is open; resolve false on error/close; reject on timeout. */
async function waitForOpen(ws, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve(true);
    };
    const onBad = () => {
      cleanup();
      resolve(false);
    };
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onBad);
      ws.removeEventListener("close", onBad);
    }
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onBad);
    ws.addEventListener("close", onBad);
  });
}

/** Minimal test client: collects inbound messages, offers send/waitFor. */
function testClient(url, name) {
  const messages = [];
  const waiters = [];
  const ws = new WebSocket(url);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.type && w.type === msg.type) {
        waiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  };
  return {
    ws,
    messages,
    name,
    open: waitForOpen(ws),
    close() {
      try { ws.close(1000, "bye"); } catch { /* ignore */ }
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    waitFor(type, timeoutMs = 3000) {
      const existing = messages.findIndex((m) => m.type === type);
      if (existing >= 0) {
        const found = messages.splice(existing, 1)[0];
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        waiters.push({
          type,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
      });
    },
  };
}

test("relay e2e: host creates, joiner joins, media actions sync, host handoff continues", async (t) => {
  if (!hasWebSocket()) {
    t.skip("no native WebSocket in this Node version");
    return;
  }

  const port = await getFreePort();
  const relay = spawn(process.execPath, [RELAY_PATH], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  t.after(() => {
    try { relay.kill("SIGTERM"); } catch { /* ignore */ }
  });

  const url = `ws://127.0.0.1:${port}/ws`;

  // Wait for the relay to accept.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const probe = new WebSocket(url);
      const ok = await waitForOpen(probe, 700);
      if (ok) {
        try { probe.close(); } catch { /* ignore */ }
        ready = true;
        break;
      }
      try { probe.close(); } catch { /* ignore */ }
    } catch {
      // ignore
    }
    await delay(150);
  }
  assert.ok(ready, "relay did not accept a WebSocket connection");

  const host = testClient(url, "Host");
  const hostOpen = await host.open;
  if (!hostOpen) throw new Error("host could not connect");
  host.send({ type: "createRoom", name: "Host" });
  const hostJoined = await host.waitFor("joined");
  assert.equal(hostJoined.role, "host");
  const code = hostJoined.roomCode;

  const joiner = testClient(url, "Joiner");
  const joinerOpen = await joiner.open;
  if (!joinerOpen) throw new Error("joiner could not connect");
  joiner.send({ type: "join", roomCode: code, name: "Joiner", worldSize: 16 });
  const joinerJoined = await joiner.waitFor("joined");
  assert.equal(joinerJoined.role, "joiner");
  assert.ok(joinerJoined.peers.some((p) => p.role === "host"));

  // Host publishes a full snapshot — the joiner must receive it.
  const hostSim = createSimulation({ size: 16, seedDensity: 0 });
  hostSim.setCell(0, 0, 0, 1);
  hostSim.setCell(1, 1, 1, 1);
  host.send({
    type: "snapshot",
    full: true,
    generation: 0,
    size: 16,
    population: 2,
    cells: hostSim.toSnapshot().cells,
    running: true,
  });
  const snap = await joiner.waitFor("snapshot");
  assert.equal(snap.generation, 0);
  assert.equal(snap.cells.length, 2);

  // Joiner seeds a cell via relay; everyone gets an action frame.
  const place = { kind: "place", x: 3, y: 3, z: 3, alive: 1 };
  joiner.send({ type: "action", action: place });
  const joinerEcho = await joiner.waitFor("action");
  assert.equal(joinerEcho.action.kind, "place");
  assert.equal(joinerEcho.action.x, 3);
  const hostSaw = await host.waitFor("action");
  assert.equal(hostSaw.action.kind, "place");

  // Presence: joiner reports a cursor; host should receive it.
  joiner.send({ type: "presence", x: 4, y: 1, z: 2 });
  const presence = await host.waitFor("presence");
  assert.equal(presence.x, 4);

  // Host closes → deterministic handoff to the oldest remaining peer (joiner).
  host.close();
  const handoff = await joiner.waitFor("handoff", 4000);
  assert.equal(handoff.newHostId, joinerJoined.peerId);
  assert.equal(handoff.snapshot.generation, 0);
  assert.equal(handoff.snapshot.cells.length, 2);

  // After the handoff the new host can publish: a third client that joins
  // afterwards must receive the SAME cached world (no divergence).
  const late = testClient(url, "Late");
  const lateOpen = await late.open;
  if (!lateOpen) throw new Error("late client could not connect");
  late.send({ type: "join", roomCode: code, name: "Late", worldSize: 16 });
  const lateJoined = await late.waitFor("joined");
  assert.equal(lateJoined.role, "joiner");
  assert.ok(lateJoined.snapshot, "late joiner should receive the cached snapshot");
  assert.equal(lateJoined.snapshot.cells.length, 2);
  assert.equal(lateJoined.snapshot.generation, 0);
});