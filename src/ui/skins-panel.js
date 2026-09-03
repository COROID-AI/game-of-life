/**
 * HUD skin selector for the 3D Game of Life.
 *
 * Builds a small dropdown into #hud (next to the sim controls) listing every
 * registry skin, lets the player switch skins at runtime without a reload, and
 * persists the active skin choice in localStorage so it is restored on load.
 *
 * Contract with the scene: the panel never touches the simulation state. It
 * only reports `applySkin(skinId)` back to the bootstrap, which forwards it to
 * the renderer. The renderer rebuilds its visual layer from the skin registry
 * entry while the engine's cells/generation keep running untouched.
 */

const STORAGE_KEY = "game-of-life-3d:active-skin";

/** Highest number of skins accepted in the selector (keeps the HUD compact). */
export const MAX_SKIN_OPTIONS = 12;

/** Number of milliseconds a cosmetic live update keeps its dying fade. */
export const DYING_FADE_MS = 1200;

function readStoredSkinId() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return typeof stored === "string" && stored.length > 0 ? stored : null;
  } catch {
    return null; // localStorage unavailable (private mode / sandbox)
  }
}

function writeStoredSkinId(id) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the skin selector UI and wire it to the provided handlers.
 * @param {Object} options
 * @param {Array<{id:string,label:string,description:string}>} options.skins Registry list.
 * @param {string} options.activeId Currently active skin id.
 * @param {(skinId: string) => void} options.onSelect Called whenever the player picks a skin.
 * @param {(skinId: string) => void} [options.onPreview] Optional hover-triggered preview hook.
 * @returns {{ select: HTMLSelectElement|null, getActiveId: () => string, setActiveId: (id: string) => void }}
 */
export function createSkinPanel({ skins, activeId, onSelect, onPreview }) {
  const host = document.getElementById("hud");
  const wrap = document.createElement("label");
  wrap.className = "skin-panel";
  wrap.title = "Visual skin — the simulation keeps running while you switch";

  const label = document.createElement("span");
  label.className = "skin-label";
  label.textContent = "Theme";
  wrap.appendChild(label);

  const select = document.createElement("select");
  select.className = "skin-select";
  select.setAttribute("aria-label", "Visual skin");

  let active = typeof activeId === "string" ? activeId : "";
  const byId = new Map(skins.map((skin) => [skin.id, skin]));

  for (const skin of skins.slice(0, MAX_SKIN_OPTIONS)) {
    if (!byId.has(skin.id)) byId.set(skin.id, skin);
    const option = document.createElement("option");
    option.value = skin.id;
    option.textContent = skin.label;
    if (skin.description) option.title = skin.description;
    select.appendChild(option);
  }

  if (byId.size === 0) {
    select.appendChild(new Option("No skins", ""));
  }

  function setActiveId(id) {
    if (!byId.has(id)) return;
    active = id;
    select.value = id;
    wrap.dataset.active = id;
    const skin = byId.get(id);
    if (skin) wrap.title = `Visual skin — ${skin.description}`;
  }

  setActiveId(active);

  select.addEventListener("change", () => {
    const next = select.value;
    if (!byId.has(next) || next === active) return;
    setActiveId(next);
    writeStoredSkinId(next);
    if (onSelect) onSelect(next);
  });

  if (onPreview) {
    select.addEventListener("mouseenter", () => onPreview(select.value));
    select.addEventListener("focus", () => onPreview(select.value));
  }

  wrap.appendChild(select);
  if (host) host.appendChild(wrap);

  return {
    select,
    getActiveId: () => active,
    setActiveId,
  };
}

export { STORAGE_KEY, readStoredSkinId, writeStoredSkinId };