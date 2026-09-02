/**
 * Entrypoint for the 3D Game of Life demo.
 *
 * Imports the bootstrap (engine + scene) and starts it as soon as the DOM is
 * ready. This module may also expose the classic 2D `window.gameOfLifeStep`
 * hook from the previous single-file demo so glider-test.html keeps passing.
 */

import { main } from "./main.js";
import * as THREE from "three";
import { createSimulation } from "./engine/simulation.js";
import {
  PRESET_RULE_SETS,
  getPreset,
  encodeRuleShare,
  decodeRuleShare,
} from "./engine/rules.js";
import { createRuleEditor } from "./ui/rules-editor.js";
import { createSession, PEER_ROLE, SESSION_STATE } from "./net/session.js";
import { peerColorFor, sanitizeName } from "./net/protocol.js";
import { createMultiplayerPanel } from "./ui/multiplayer-panel.js";

const app = document.getElementById("app");
if (!app) {
  throw new Error('index.html must contain an element with id="app"');
}

const handle = main(app, { size: 16, seedDensity: 0.2, speed: 4 });
window.__life3d = handle;

// ---- Custom rule editor (swap rules live, save/load/share) ----------------
let editor = null;
try {
  editor = createRuleEditor({
    presets: PRESET_RULE_SETS,
    initial: handle.getActiveRule(),
    onApply: (ruleSet) => handle.applyRuleSet(ruleSet),
    shareEncode: encodeRuleShare,
    shareDecode: decodeRuleShare,
  });
  window.__life3d.editor = editor;
} catch (err) {
  console.error("Could not start the rule editor:", err);
}

// Preserve a couple of engine-level conveniences on the window handle.
window.getPresetRule = getPreset;

/**
 * Compat hook for glider-test.html: pure, non-mutating classic 2D Conway.
 * Runs the plane-constrained engine (z=0) so the glider translates +1/+1
 * every 4 generations exactly like the original 2D demo. Returns a new array.
 */
window.gameOfLifeStep = function gameOfLifeStep(cells) {
  const rows = Array.isArray(cells) ? cells.length : 0;
  const cols = rows > 0 && Array.isArray(cells[0]) ? cells[0].length : 0;
  const size = Math.max(rows, cols) + 2; // margin so hard walls never interfere
  const sim = createSimulation({ size, seedDensity: 0 });

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (cells[y][x] === 1) sim.setCell(x, y, 0, 1);
    }
  }
  sim.tick({ plane: "z", planeOffset: 0 });

  const next = new Array(rows);
  for (let y = 0; y < rows; y++) {
    const row = new Array(cols).fill(0);
    for (let x = 0; x < cols; x++) {
      row[x] = sim.getCell(x, y, 0);
    }
    next[y] = row;
  }
  return next;
};

// ---- Minimal HUD wiring (stats + play/pause/step) --------------------------
const playPauseBtn = document.getElementById("play-pause-btn");
const stepBtn = document.getElementById("step-btn");
const genEl = document.getElementById("generation");
const popEl = document.getElementById("population");

function updateHud() {
  if (genEl) genEl.textContent = String(handle.simulation.generation);
  if (popEl) popEl.textContent = String(handle.simulation.population);
  if (playPauseBtn) playPauseBtn.textContent = handle.isRunning() ? "Pause" : "Play";
}

if (playPauseBtn) {
  playPauseBtn.addEventListener("click", () => {
    if (handle.isRunning()) handle.stop();
    else handle.start();
    updateHud();
  });
}
if (stepBtn) {
  stepBtn.addEventListener("click", () => {
    handle.step();
    updateHud();
  });
}

setInterval(updateHud, 200);
updateHud();

// ---- Multiplayer session bootstrap ------------------------------------------
// Authoritative-host model: the room HOST ticks the deterministic simulation
// and broadcasts snapshots; joiners apply them. Every mediated action is
// validated and rebroadcast so all clients stay converged.
const inRoomMode = () => {
  const st = session.getState?.() ?? "booting";
  return st === "joined" || st === "host" || st === "connecting" || st === "connected";
};

const session = createSession(handle.simulation, {
  onState: (info) => {
    const isHost = info.role === PEER_ROLE.HOST;
    handle.simulation.__mpIsHost = isHost;
    // The single authority loop: when hosting, stop main's *local* interval
    // and let the room driver (session.tick) own ticking + broadcasting.
    // Joiners never tick locally; they render authoritative snapshots.
    if (isHost) {
      rawHandleStop(); // halt the local interval; session.tick() drives now
    } else if (info.state === "joined") {
      rawHandleStop(); // joiners must not diverge by ticking their own sim
    }
    window.dispatchEvent(new CustomEvent("life3d:session-state", { detail: info }));
  },
  onRoster: ({ peers, hostId }) => {
    // Render remote presence markers in the 3D scene for every peer except me.
    const me = session.getPeerId();
    const list = (peers ?? []).map((p) => ({
      peerId: p.peerId,
      name: p.name,
      color: peerColorFor(p.peerId),
      me,
    }));
    handle.scene.setPresence(list);
    window.dispatchEvent(new CustomEvent("life3d:roster", { detail: { peers, hostId } }));
  },
  onPresence: ({ peer, x, y, z }) => {
    if (peer && peer.peerId !== session.getPeerId()) {
      handle.scene.updatePresenceMarker(peer.peerId, x, y, z);
    } else if (peer?.id && peer.id !== session.getPeerId()) {
      handle.scene.updatePresenceMarker(peer.id, x, y, z);
    }
  },
  onSnapshot: (snapshot) => {
    // Lattice already restored by the session over fromSnapshot(); refresh
    // the voxels so the scene matches the authoritative world.
    handle.scene.syncVoxels();
    handle.scene.render();
    updateHud();
    window.dispatchEvent(new CustomEvent("life3d:snapshot", { detail: snapshot }));
  },
  onAction: ({ action, sender }) => {
    if (action.kind === "skin") {
      rawHandleSetSkin(action.skinId); // apply directly; never re-route (loop)
    }
    if (action.kind === "rule") {
      rawHandleApplyRuleSet(action.rule);
      if (editor) editor.setActiveRule?.(action.rule);
    }
    if (action.kind === "place") {
      handle.scene.syncVoxels();
      handle.scene.render();
    }
    updateHud();
    window.dispatchEvent(new CustomEvent("life3d:action", { detail: { action, sender } }));
  },
  onHandoff: (info) => {
    // The promoted client is now host. session.hostRunning was restored from
    // the relay's snapshot; the room driver resumes ticking + broadcasting on
    // the next rAF. Do NOT start main's local interval (double-tick).
    handle.scene.syncVoxels();
    handle.scene.render();
    window.dispatchEvent(new CustomEvent("life3d:handoff", { detail: info }));
  },
  onTick: (info) => {
    // Host ticks advance the sim directly; refresh the lattice in the scene.
    handle.scene.syncVoxels();
    updateHud();
  },
  onJoined: (info) => {
    // Seed the host authority with any rule already active in this client
    // (e.g. a rule picked before creating the room).
    if (info.role === PEER_ROLE.HOST) {
      session.setHostRule(handle.getActiveRule());
    }
    window.dispatchEvent(new CustomEvent("life3d:joined", { detail: info }));
  },
  onError: (err) => {
    console.warn("multiplayer:", err.message);
    window.dispatchEvent(new CustomEvent("life3d:error", { detail: err }));
  },
});

// Seed-mode pointer: click a voxel cell to place (host-mediated, broadcast).
let seedMode = false;
handle.scene.renderer.domElement.addEventListener("pointerdown", (ev) => {
  if (!seedMode) return;
  const rect = handle.scene.renderer.domElement.getBoundingClientRect();
  const ndc = {
    x: ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    y: -(((ev.clientY - rect.top) / rect.height) * 2 - 1),
  };
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, handle.scene.camera);
  const gridPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  raycaster.ray.intersectPlane(gridPlane, hit);
  const size = handle.simulation.size;
  const half = Math.floor(size / 2);
  const cellX = Math.round(hit.x);
  const cellY = Math.round(hit.y);
  const cellZ = Math.round(hit.z);
  if (cellX >= -half && cellX < half && cellY >= -half && cellY < half && cellZ >= -half && cellZ < half) {
    const alive = !handle.simulation.getCell(cellX, cellY, cellZ);
    session.requestPlace(cellX, cellY, cellZ, alive ? 1 : 0);
  }
});

handle.scene.renderer.domElement.addEventListener("pointermove", (ev) => {
  if (!seedMode) return;
  const rect = handle.scene.renderer.domElement.getBoundingClientRect();
  const ndc = {
    x: ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    y: -(((ev.clientY - rect.top) / rect.height) * 2 - 1),
  };
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, handle.scene.camera);
  const gridPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  raycaster.ray.intersectPlane(gridPlane, hit);
  session.sendPresence({ x: Math.round(hit.x), y: Math.round(hit.y), z: Math.round(hit.z) });
});

function toggleSeedMode() {
  seedMode = !seedMode;
  handle.scene.renderer.domElement.style.cursor = seedMode ? "crosshair" : "";
  window.dispatchEvent(new CustomEvent("life3d:seed-mode", { detail: { on: seedMode } }));
}

// Expose the session for browser verification / debugging.
window.__life3dSession = session;
window.__life3dSeedMode = toggleSeedMode;

// Create the multiplayer panel (HUD room bar).
const mpPanel = createMultiplayerPanel({ session, scene: handle.scene });

// ---- Room-mode driver and action routing -------------------------------------
const rawHandleStop = handle.stop.bind(handle);
const rawHandleStart = handle.start.bind(handle);
const rawHandleStep = handle.step.bind(handle);
const rawHandleSetSkin = handle.setSkin.bind(handle);
const rawHandleApplyRuleSet = handle.applyRuleSet.bind(handle);
const rawHandleReset = handle.reset.bind(handle);

let lastSessionTick = 0;
function roomDriver() {
  if (session.isHost?.()) {
    session.tick();
  }
  requestAnimationFrame(roomDriver);
}
requestAnimationFrame(roomDriver);

// When in a room, route skin/rule/pause/resume/step/clear through the session
// so the whole room stays converged (host-mediated + broadcast).
const origSetSkin = rawHandleSetSkin;
handle.setSkin = (skinId) => {
  if (inRoomMode()) {
    session.requestSkin(skinId);
    return true;
  }
  return origSetSkin(skinId);
};
const origApplyRuleSet = rawHandleApplyRuleSet;
handle.applyRuleSet = (ruleSet) => {
  if (inRoomMode()) {
    session.setHostRule(ruleSet); // host uses it for the next tick
    session.requestRule(ruleSet);
    return ruleSet;
  }
  return origApplyRuleSet(ruleSet);
};
const origStart = rawHandleStart;
handle.start = () => {
  if (inRoomMode()) {
    session.requestResume();
    return;
  }
  return origStart();
};
const origStop = rawHandleStop;
handle.stop = () => {
  if (inRoomMode()) {
    session.requestPause();
    return;
  }
  return origStop();
};
const origStep = rawHandleStep;
handle.step = () => {
  if (inRoomMode()) {
    session.requestStep();
    return;
  }
  return origStep();
};
handle.reset = ((origReset) => (density) => {
  if (inRoomMode()) {
    session.requestClear();
    return handle.simulation;
  }
  return origReset(density);
})(rawHandleReset);

handle.dispose = (() => {
  const oldDispose = handle.dispose.bind(handle);
  return () => {
    try { session.leave(); } catch { /* ignore */ }
    if (mpPanel && mpPanel.destroy) mpPanel.destroy();
    oldDispose();
  };
})();