/**
 * First-run onboarding tour for the 3D Game of Life HUD.
 *
 * New players discover the simulator's key features through a small sequence
 * of dismissible tooltips pinned to HUD elements:
 *
 *   1. Camera controls (orbit/zoom)  → fixed bottom hint bar
 *   2. Rule-set editor (⚙ Rules)      → the HUD rules button
 *   3. Skin selector (Theme dropdown) → the HUD skin panel
 *   4. Multiplayer room creation      → the MP "Create room" button
 *   5. Grid size preset               → the HUD grid/graphics control
 *
 * Every step shows a callout with "Next / Skip" actions and a per-step bullet
 * summary. Steps render and dismiss; state (last completed step) persists in
 * localStorage so first-run visitors see the tour once and returning visitors
 * stay unbothered. Each step emits the `hint:shown` / `hint:dismissed`
 * metrics so onboarding coverage is measurable.
 *
 * The module is DOM-only: it does not touch the simulation or the scene.
 */

import { METRIC_EVENTS } from "../analytics/metrics.js";

/** localStorage key for first-run completion state. */
export const HINT_STORAGE_KEY = "game-of-life-3d:onboarding-v1";

/** Tour steps with DOM selectors (must exist before start() runs). */
export const FIRST_RUN_STEPS = Object.freeze([
  {
    id: "camera",
    label: "Camera controls",
    text: "Drag to orbit the 3D lattice. Scroll to zoom in and out. Tip: orbit around any side to inspect growth.",
  },
  {
    id: "rules",
    label: "Rule-set editor",
    text: "Open ⚙ Rules to author custom B/S rule-sets, apply presets, save your favourites, and share them as compact codes.",
  },
  {
    id: "skins",
    label: "Skins",
    text: "Use the Theme dropdown to switch visual skins live — Classic Voxels, Neon Wireframe, and Organic. The simulation keeps running.",
  },
  {
    id: "multiplayer",
    label: "Multiplayer",
    text: "Click Create room to host a shared session, then send the room code or link to friends. Joiners see the same lattice in sync.",
  },
  {
    id: "grid",
    label: "Grid size & quality",
    text: "Pick a grid preset in the HUD to trade off population vs. performance. Large grids stay playable thanks to instanced rendering and auto quality guards.",
  },
]);

function safeStorage() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** True when the visitor has not yet finished (or skipped) the tour. */
export function shouldShowTour(storage = safeStorage()) {
  try {
    return !storage || storage.getItem(HINT_STORAGE_KEY) !== "done";
  } catch {
    return true; // no persistence → still show once per page load
  }
}

/** Mark the tour done (or set an explicit step). Returns true only when the
 * completion state was actually persisted. */
export function markTourDone(storage = safeStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(HINT_STORAGE_KEY, "done");
    return true;
  } catch {
    return false;
  }
}

function anchorRect(selector) {
  const node = document.querySelector(selector);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return rect;
}

/** Place the callout bubble near an element, clamped inside the viewport. */
function positionCallout(bubble, rect) {
  const PAD = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;

  let left = rect.left + rect.width / 2 - bw / 2;
  left = Math.max(PAD, Math.min(left, vw - bw - PAD));
  let top = rect.bottom + 10;
  if (top + bh > vh - PAD) top = Math.max(PAD, rect.top - bh - 10);
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
}

/**
 * Start the onboarding tour.
 * @param {Object} options
 * @param {Object} [options.metrics] Metrics reporter from metrics.js (optional).
 * @param {Function} [options.onDone] Called when the tour finishes or is skipped.
 * @returns {{ destroy: () => void, getState: () => { active: boolean, index:
 *   number, done: boolean } }} handle for tests / HMR teardown.
 */
export function createOnboarding({ metrics = null, onDone } = {}) {
  const host = document.getElementById("hud");
  if (!host) return { destroy: () => {}, getState: () => ({ active: false, index: -1, done: true }) };

  const steps = FIRST_RUN_STEPS.map((step) => ({
    ...step,
    anchor:
      step.id === "camera"
        ? "#hint"
        : step.id === "rules"
          ? ".re-open"
          : step.id === "skins"
            ? ".skin-panel"
            : step.id === "multiplayer"
              ? "#mp-create"
              : ".grid-preset-wrap",
  }));

  const wrap = document.createElement("div");
  wrap.className = "ob-wrap";
  wrap.hidden = true;

  const bubble = document.createElement("div");
  bubble.className = "ob-bubble";

  const title = document.createElement("div");
  title.className = "ob-title";
  const text = document.createElement("div");
  text.className = "ob-text";
  const bullets = document.createElement("div");
  bullets.className = "ob-bullets";

  const actions = document.createElement("div");
  actions.className = "ob-actions";
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "ob-btn ob-prev";
  prevBtn.textContent = "Back";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "ob-btn ob-next";
  nextBtn.textContent = "Next";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "ob-btn ob-done";
  doneBtn.textContent = "Got it";
  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "ob-btn ob-skip";
  skipBtn.textContent = "Skip tour";
  actions.append(prevBtn, nextBtn, doneBtn, skipBtn);

  const dots = document.createElement("div");
  dots.className = "ob-dots";

  bubble.append(title, text, bullets, actions, dots);
  wrap.appendChild(bubble);
  document.body.appendChild(wrap);

  let index = 0;
  let active = false;
  let hintEl = null;

  let rafTimer = null;

  const emit = (name, fields = {}) => {
    if (metrics && typeof metrics.record === "function") {
      try {
        metrics.record(name, { step: steps[index]?.id ?? "", ...fields });
      } catch {
        // non-fatal
      }
    }
  };

  function bulletsHtml() {
    return steps
      .map(
        (s, i) =>
          `<span class="ob-dot${i === index ? " on" : ""}" data-i="${i}" title="${s.label}"></span>`,
      )
      .join("");
  }

  function showStep(i) {
    index = (i + steps.length) % steps.length;
    const step = steps[index];
    title.textContent = step.label;
    text.textContent = step.text;
    bubbles();
    dots.innerHTML = bulletsHtml();
    prevBtn.hidden = index === 0;
    nextBtn.hidden = index === steps.length - 1;
    doneBtn.hidden = index !== steps.length - 1;
    skipBtn.hidden = false;
    repaint();
    emit(METRIC_EVENTS.HINT_SHOWN);
  }

  function repaint() {
    const step = steps[index];
    const rect = anchorRect(step.anchor);
    if (!rect) return;
    positionCallout(bubble, rect);
    // Highlight the anchored element (make sure the tooltip stays on top).
    for (const el of document.querySelectorAll(".ob-highlight")) el.classList.remove("ob-highlight");
    const target = document.querySelector(step.anchor);
    if (target && step.anchor !== "#hint") target.classList.add("ob-highlight");
  }

  // The bubble's first layout pass happens after it becomes visible; nudge
  // once the fonts/layout settle so the position is accurate.
  function bubbles() {
    wrap.hidden = false;
    bubble.style.visibility = "hidden";
    requestAnimationFrame(() => {
      bubble.style.visibility = "visible";
      repaint();
    });
  }

  function finish() {
    active = false;
    wrap.hidden = true;
    markTourDone();
    if (typeof onDone === "function") onDone({ completed: true, index });
    window.dispatchEvent(new CustomEvent("life3d:onboarding-done", { detail: { step: steps[index]?.id } }));
  }

  function dismiss() {
    active = false;
    wrap.hidden = true;
    if (!metrics) markTourDone();
    if (typeof onDone === "function") onDone({ completed: false, index });
    window.dispatchEvent(new CustomEvent("life3d:onboarding-dismissed", { detail: { step: steps[index]?.id } }));
    emit(METRIC_EVENTS.HINT_DISMISSED, { step: steps[index]?.id });
  }

  function start() {
    if (active || !shouldShowTour()) return false;
    if (!steps.some((s) => anchorRect(s.anchor))) return false;
    active = true;
    showStep(0);
    // Leave an escape: any click on the backdrop or Escape closes the tour.
    const onKey = (e) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) finish();
    });
    // Keep the callout pinned to a moving camera hint bar / HUD.
    const loop = () => {
      if (active) repaint();
      rafTimer = requestAnimationFrame(loop);
    };
    rafTimer = requestAnimationFrame(loop);
    return true;
  }

  prevBtn.addEventListener("click", () => showStep(index - 1));
  nextBtn.addEventListener("click", () => showStep(index + 1));
  doneBtn.addEventListener("click", finish);
  skipBtn.addEventListener("click", dismiss);

  return {
    destroy() {
      active = false;
      if (rafTimer) cancelAnimationFrame(rafTimer);
      if (wrap.parentNode === document.body) document.body.removeChild(wrap);
    },
    getState: () => ({ active, index, done: !shouldShowTour() }),
    showStep,
    start,
    finish,
    dismiss,
  };
}