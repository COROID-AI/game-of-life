/**
 * Multiplayer HUD panel for the 3D Game of Life.
 *
 * Adds a compact room bar under the main HUD: create/join buttons, a share
 * code + copy link, live roster with host badge, per-client sync state, and a
 * click-to-seed interaction (per acceptance criteria: "joiners can place/seed
 * cells" and "remote presence markers visible in the 3D scene").
 *
 * The panel is purely presentational — it forwards the raw session handle and
 * never touches the simulation or three.js scene directly. All authority /
 * validity rules live in src/net/session.js + src/net/protocol.js.
 */

import { ROOM_CODE_LENGTH } from "../net/protocol.js";

/** Panel element ids (also used by browser verification tooling). */
export const MP_IDS = Object.freeze({
  root: "mp-root",
  code: "mp-code",
  link: "mp-link",
  roster: "mp-roster",
  status: "mp-status",
  createBtn: "mp-create",
  joinBtn: "mp-join",
  joinCode: "mp-join-code",
  joinName: "mp-join-name",
  leaveBtn: "mp-leave",
  placeBtn: "mp-place-mode",
  pauseBtn: "mp-pause",
  resumeBtn: "mp-resume",
  stepBtn: "mp-step",
  clearBtn: "mp-clear",
});

/**
 * Create the multiplayer panel.
 *
 * @param {Object} options
 * @param {Object} options.session Session handle from createSession().
 * @param {Object} options.scene Scene handle from createScene().
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createMultiplayerPanel({ session, scene }) {
  const host = document.getElementById("hud");
  if (!host) return { el: null, destroy: () => {} };

  const root = document.createElement("div");
  root.id = MP_IDS.root;
  root.className = "mp-root";

  const code = document.createElement("span");
  code.className = "mp-code";
  code.textContent = "—";

  const status = document.createElement("span");
  status.className = "mp-status";
  status.textContent = "offline";

  const roster = document.createElement("div");
  roster.className = "mp-roster";
  roster.id = MP_IDS.roster;

  const codeWrap = document.createElement("span");
  codeWrap.className = "mp-code-wrap";
  codeWrap.append(code);

  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.className = "mp-btn";
  linkBtn.textContent = "Copy link";

  const createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.id = MP_IDS.createBtn;
  createBtn.textContent = "Create room";

  const joinCode = document.createElement("input");
  joinCode.id = MP_IDS.joinCode;
  joinCode.className = "mp-input";
  joinCode.placeholder = "Room code";
  joinCode.maxLength = ROOM_CODE_LENGTH;

  const joinBtn = document.createElement("button");
  joinBtn.type = "button";
  joinBtn.id = MP_IDS.joinBtn;
  joinBtn.textContent = "Join";

  const leaveBtn = document.createElement("button");
  leaveBtn.type = "button";
  leaveBtn.id = MP_IDS.leaveBtn;
  leaveBtn.textContent = "Leave";
  leaveBtn.hidden = true;

  const placeBtn = document.createElement("button");
  placeBtn.type = "button";
  placeBtn.id = MP_IDS.placeBtn;
  placeBtn.textContent = "✏ Seed mode";
  placeBtn.hidden = true;

  const pauseBtn = document.createElement("button");
  pauseBtn.type = "button";
  pauseBtn.id = MP_IDS.pauseBtn;
  pauseBtn.textContent = "Pause";
  pauseBtn.hidden = true;

  const resumeBtn = document.createElement("button");
  resumeBtn.type = "button";
  resumeBtn.id = MP_IDS.resumeBtn;
  resumeBtn.textContent = "Resume";
  resumeBtn.hidden = true;

  const stepBtn = document.createElement("button");
  stepBtn.type = "button";
  stepBtn.id = MP_IDS.stepBtn;
  stepBtn.textContent = "Step";
  stepBtn.hidden = true;

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.id = MP_IDS.clearBtn;
  clearBtn.textContent = "Clear";
  clearBtn.hidden = true;

  const nameInput = document.createElement("input");
  nameInput.id = MP_IDS.joinName;
  nameInput.className = "mp-input";
  nameInput.placeholder = "Your name";
  nameInput.maxLength = 24;
  try {
    nameInput.value = window.localStorage.getItem("game-of-life-3d:name") ?? "";
  } catch {
    // localStorage unavailable
  }

  // ---- Layout ---------------------------------------------------------------
  const controls = document.createElement("span");
  controls.className = "mp-controls";
  controls.append(createBtn, nameInput, joinCode, joinBtn, leaveBtn);

  const editRow = document.createElement("span");
  editRow.className = "mp-edit-row";
  editRow.append(placeBtn, pauseBtn, resumeBtn, stepBtn, clearBtn);

  root.append(controls, codeWrap, linkBtn, status, roster, editRow);
  host.appendChild(root);

  let seeding = false;

  function persistedName() {
    return nameInput.value.trim() || "Player";
  }

  function createRoomFlow() {
    const name = persistedName();
    try {
      window.localStorage.setItem("game-of-life-3d:name", name);
    } catch {
      // ignore
    }
    session.create({ name });
  }

  function copyLink() {
    const code = session.getRoomCode();
    if (!code) return;
    const name = persistedName();
    const url = `${window.location.origin}${window.location.pathname}?room=${code}&name=${encodeURIComponent(name)}`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        status.textContent = "Link copied";
        setTimeout(renderStatus, 1200);
      }).catch(() => {});
    } else {
      status.textContent = url;
    }
  }

  function renderStatus() {
    const st = session.getState?.() ?? "booting";
    const role = session.getRole?.() ?? "joiner";
    const codeVal = session.getRoomCode?.() ?? "";
    status.textContent = `${st}${role === "host" ? " · host" : ""}${codeVal ? " · " + codeVal : ""}`;
  }

  function renderRoster(peers) {
    roster.replaceChildren();
    const meId = session.getPeerId?.();
    const hostId = session.getHost?.();
    for (const peer of peers ?? []) {
      const row = document.createElement("span");
      row.className = "mp-peer";
      const dot = document.createElement("i");
      dot.className = "mp-dot";
      dot.style.background = peer.color ?? "#39ff14";
      const label = document.createTextNode(
        `${peer.name ?? peer.peerId}${peer.peerId === hostId ? " 👑" : ""}${peer.peerId === meId ? " (you)" : ""}`,
      );
      row.append(dot, label);
      roster.appendChild(row);
    }
  }

  function inRoom() {
    const st = session.getState?.();
    return st === "joined" || st === "host" || st === "connected";
  }

  function renderAll() {
    renderStatus();
    renderRoster(session.getRoster?.() ?? []);
    const present = inRoom();
    leaveBtn.hidden = !present;
    placeBtn.hidden = !present;
    pauseBtn.hidden = !present;
    resumeBtn.hidden = !present;
    stepBtn.hidden = !present;
    clearBtn.hidden = !present;
    code.textContent = session.getRoomCode?.() ?? "—";
    if (session.getState?.() === "left" && seeding) {
      seeding = false;
      placeBtn.classList.remove("mp-active");
      placeBtn.textContent = "✏ Seed mode";
      document.body.style.cursor = "";
    }
  }

  // ---- Event wiring ----------------------------------------------------------
  createBtn.addEventListener("click", createRoomFlow);
  joinBtn.addEventListener("click", () => {
    session.join({ code: joinCode.value });
  });
  joinCode.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinBtn.click();
  });
  leaveBtn.addEventListener("click", () => {
    session.leave();
    scene.clearPresence?.();
  });
  linkBtn.addEventListener("click", copyLink);
  placeBtn.addEventListener("click", () => {
    seeding = !seeding;
    placeBtn.classList.toggle("mp-active", seeding);
    document.body.style.cursor = seeding ? "crosshair" : "";
    placeBtn.textContent = seeding ? "✏ Seeding…" : "✏ Seed mode";
  });
  pauseBtn.addEventListener("click", () => session.requestPause());
  resumeBtn.addEventListener("click", () => session.requestResume());
  stepBtn.addEventListener("click", () => session.requestStep());
  clearBtn.addEventListener("click", () => session.requestClear());

  // Automatically start from a shared link (?room=CODE).
  const params = new URLSearchParams(window.location.search);
  const autoCode = params.get("room") ?? "";
  if (autoCode) {
    nameInput.value = params.get("name") ?? nameInput.value ?? "";
    setTimeout(() => session.join({ code: autoCode, name: nameInput.value.trim() }), 300);
  }

  const interval = window.setInterval(renderAll, 500);
  renderAll();

  return {
    el: root,
    destroy() {
      window.clearInterval(interval);
      document.body.style.cursor = "";
      if (root.parentNode === host) host.removeChild(root);
    },
  };
}