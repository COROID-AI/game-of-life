/**
 * Rule editor UI for the 3D Game of Life.
 *
 * Renders a rule-set panel inside the main HUD (`#hud`) so the editor entry
 * point is visible without scrolling or hunting. Players can:
 *
 *   - pick one of the five built-in presets (Conway B3/S23, HighLife B36/S23,
 *     Seeds B2/S, Day & Night B3678/S34678, and a 3D-flavoured rule),
 *   - author custom rules by toggling birth/survival neighbour counts
 *     0..26 (toggle buttons for 0-25 plus a numeric field for 26),
 *   - name rules, then save / re-apply / delete them; saved rules persist
 *     in localStorage across reloads,
 *   - share rules through a compact copy-paste code and import codes on a
 *     fresh page.
 *
 * Every edit, preset pick, save, or import calls `onApply(ruleSet)`
 * immediately, so the running simulation swaps rule-sets on the next tick
 * without a restart or reload.
 *
 * This module is DOM-fast (it owns no simulation state); the actual rule
 * transition logic lives in src/engine/rules.js and src/engine/simulation.js.
 */

import { toRuleString } from "../engine/rules.js";

const STORAGE_KEY = "life3d.customRuleSets.v1";
export const MAX_SAVED = 24;

/** Selectable neighbour counts 0..25 (26 is handled by a dedicated field). */
export const COUNT_OPTIONS = Object.freeze(Array.from({ length: 26 }, (_, i) => i));

// ---- localStorage persistence ---------------------------------------------

/** Load custom rule-sets from localStorage (validated, newest-last). */
export function loadCustomRules(storage = window.localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r) =>
          r &&
          typeof r.id === "string" &&
          typeof r.name === "string" &&
          Array.isArray(r.birth) &&
          Array.isArray(r.survive) &&
          r.birth.every((n) => Number.isInteger(n) && n >= 0 && n <= 26) &&
          r.survive.every((n) => Number.isInteger(n) && n >= 0 && n <= 26),
      )
      .slice(0, MAX_SAVED);
  } catch {
    return [];
  }
}

/** Persist custom rule-sets to localStorage. */
export function saveCustomRules(rules, storage = window.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(rules.slice(0, MAX_SAVED)));
    return true;
  } catch {
    return false;
  }
}

// ---- DOM helpers -----------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sameTransition(a, b) {
  return toRuleString(a) === toRuleString(b);
}

function newRuleId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function copyToClipboard(text) {
  const ta = el("textarea", "");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

/**
 * Create the rule editor panel and wire it into `#hud`.
 *
 * @param {Object} options
 * @param {Object[]} options.presets Preset rule-sets (from rules.js).
 * @param {(ruleSet: Object) => void} options.onApply Live rule application.
 * @param {Object} [options.initial] Initially active rule-set.
 * @param {(ruleSet: Object) => string} [options.shareEncode] Share-code encoder.
 * @param {(code: string) => Object} [options.shareDecode] Share-code decoder.
 * @param {() => Object[]} [options.readStorage] Custom-rule loader.
 * @param {(rules: Object[]) => void} [options.writeStorage] Custom-rule saver.
 * @returns {Object} `{ root, open, close, updateActive, getActive }`.
 */
export function createRuleEditor({
  presets,
  onApply,
  initial,
  shareEncode,
  shareDecode,
  readStorage = () => loadCustomRules(),
  writeStorage = (rules) => saveCustomRules(rules),
}) {
  if (!Array.isArray(presets) || presets.length === 0) {
    throw new TypeError("createRuleEditor requires a non-empty presets array");
  }
  if (typeof onApply !== "function") {
    throw new TypeError("createRuleEditor requires an onApply callback");
  }

  let customRules = readStorage();
  let active = { ...(initial ?? presets[0]) };
  let dirty = false;
  let toastTimer = null;

  // Draft being edited: counts are Sets, name is a plain string.
  const draft = {
    name: active.name ?? "Custom",
    birth: new Set(active.birth ?? []),
    survive: new Set(active.survive ?? []),
  };

  // ---- HUD slice (prominent entry point, no scrolling needed) --------------
  const hudSlice = el("div", "re-hud");
  const openBtn = el("button", "re-open", "⚙ Rules");
  openBtn.type = "button";
  openBtn.title = "Open the rule editor";
  const activeBadge = el("span", "re-active", "");
  hudSlice.appendChild(openBtn);
  hudSlice.appendChild(activeBadge);
  document.getElementById("hud").appendChild(hudSlice);

  // ---- Modal ---------------------------------------------------------------
  const modal = el("div", "re-modal");
  modal.hidden = true;
  document.body.appendChild(modal);

  const panel = el("div", "re-panel");
  modal.appendChild(panel);

  const header = el("div", "re-header");
  header.appendChild(el("div", "re-title", "Rule Editor"));
  const closeBtn = el("button", "re-close", "×");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const nameInput = el("input", "re-name");
  nameInput.type = "text";
  nameInput.maxLength = 40;
  nameInput.placeholder = "Rule name";
  panel.appendChild(nameInput);

  // Preset picker: presets plus a custom arc. Selecting applies immediately.
  const presetSelect = el("select", "re-preset-select");
  for (const p of presets) presetSelect.appendChild(new Option(p.name, p.id));
  presetSelect.appendChild(new Option("Custom (auto)", "__custom__", undefined, true));
  panel.appendChild(presetSelect);

  const ruleStr = el("div", "re-rule-str", "");
  panel.appendChild(ruleStr);

  // ---- Count grids ---------------------------------------------------------
  /** Build one birth/survival toggle grid (0-25 buttons + 26 field). */
  function buildCountGrid(kind) {
    const wrap = el("div", `re-counts re-${kind}`);
    const legend = el(
      "div",
      "re-legend",
      kind === "birth" ? "Birth — dead cells with this many neighbours" : "Survival — live cells kept alive",
    );
    wrap.appendChild(legend);

    const grid = el("div", "re-grid");
    const group = { kind, grid, buttons: new Map() };

    for (const n of COUNT_OPTIONS) {
      const btn = el("button", "re-count", String(n));
      btn.type = "button";
      btn.dataset.n = String(n);
      btn.addEventListener("click", () => toggleCount(group, n));
      grid.appendChild(btn);
      group.buttons.set(n, btn);
    }
    wrap.appendChild(grid);

    const bottom = el("div", "re-count-bottom");
    const highBtn = el("button", "re-count", "26");
    highBtn.type = "button";
    highBtn.dataset.n = "26";
    highBtn.addEventListener("click", () => toggleCount(group, 26));
    bottom.appendChild(highBtn);
    group.buttons.set(26, highBtn);

    const num = el("input", "re-count-num");
    num.type = "number";
    num.min = "0";
    num.max = "26";
    num.step = "1";
    num.placeholder = "0–26";
    num.addEventListener("input", () => {
      const v = Number(num.value);
      if (Number.isInteger(v) && v >= 0 && v <= 26) {
        toggleCount(group, v);
        num.value = "";
      }
    });
    bottom.appendChild(num);
    wrap.appendChild(bottom);
    return { kind, grid, buttons: group.buttons, wrap };
  }

  const birthGroup = buildCountGrid("birth");
  const surviveGroup = buildCountGrid("survive");
  panel.appendChild(birthGroup.wrap);
  panel.appendChild(surviveGroup.wrap);

  // ---- Actions -------------------------------------------------------------
  const actions = el("div", "re-actions");
  const applyBtn = el("button", "re-btn primary re-apply", "Apply");
  const saveBtn = el("button", "re-btn re-save", "Save");
  const shareBtn = el("button", "re-btn re-share", "Share");
  const importToggleBtn = el("button", "re-btn re-import-toggle", "Import…");
  const doneBtn = el("button", "re-btn re-done", "Done");
  for (const b of [applyBtn, saveBtn, shareBtn, importToggleBtn, doneBtn]) b.type = "button";
  applyBtn.addEventListener("click", () => applyDraft());
  saveBtn.addEventListener("click", saveDraft);
  shareBtn.addEventListener("click", shareDraft);
  importToggleBtn.addEventListener("click", () => {
    importSection.hidden = !importSection.hidden;
  });
  doneBtn.addEventListener("click", close);
  for (const b of [applyBtn, saveBtn, shareBtn, importToggleBtn, doneBtn]) actions.appendChild(b);
  panel.appendChild(actions);

  // ---- Import --------------------------------------------------------------
  const importSection = el("div", "re-import");
  importSection.hidden = true;
  const importInput = el("input", "re-import-input");
  importInput.type = "text";
  importInput.placeholder = "Paste rule code — B3/S23 or life3d:rule:…";
  const importBtn = el("button", "re-btn re-import-btn", "Import");
  importBtn.type = "button";
  importBtn.addEventListener("click", () => importCode(importInput.value));
  importInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") importCode(importInput.value);
  });
  importSection.appendChild(importInput);
  importSection.appendChild(importBtn);
  panel.appendChild(importSection);

  // ---- Saved rules ---------------------------------------------------------
  const savedRow = el("div", "re-saved-row");
  savedRow.appendChild(el("div", "re-saved-title", "My rules"));
  const savedList = el("div", "re-saved-list");
  savedRow.appendChild(savedList);
  panel.appendChild(savedRow);

  const toastEl = el("div", "re-toast");
  toastEl.hidden = true;
  panel.appendChild(toastEl);

  // ---- Core helpers --------------------------------------------------------
  function draftRule() {
    return {
      id: "draft",
      name: draft.name.trim() || "Custom",
      mode: "life-like",
      birth: [...draft.birth].sort((a, b) => a - b),
      survive: [...draft.survive].sort((a, b) => a - b),
    };
  }

  function syncGrid(group) {
    const set = group.kind === "birth" ? draft.birth : draft.survive;
    for (const [n, btn] of group.buttons) btn.classList.toggle("on", set.has(n));
  }

  function updateReadout() {
    ruleStr.textContent = toRuleString(active);
  }

  function updateBadge(rule) {
    activeBadge.textContent = rule?.name ?? ruleStr.textContent;
    activeBadge.title = `Active rule: ${rule?.name ?? ""} (${toRuleString(rule ?? active)})`;
  }

  function toggleCount(group, n) {
    const set = group.kind === "birth" ? draft.birth : draft.survive;
    if (set.has(n)) set.delete(n);
    else set.add(n);
    dirty = true;
    syncGrid(group);
    updateReadout();
    applyDraft();
  }

  function applyDraft() {
    const rule = draftRule();
    active = { ...rule, id: active.id && !dirty ? active.id : newRuleId() };
    onApply(active);
    updateBadge(active);
    syncRuleStr();
    return active;
  }

  function syncRuleStr() {
    ruleStr.textContent = toRuleString(active);
  }

  function loadRule(rule) {
    active = { ...rule };
    draft.name = rule.name ?? "Custom";
    draft.birth = new Set(rule.birth ?? []);
    draft.survive = new Set(rule.survive ?? []);
    dirty = false;
    nameInput.value = draft.name;
    presetSelect.value = presets.some((p) => p.id === rule.id) ? rule.id : "__custom__";
    syncGrid(birthGroup);
    syncGrid(surviveGroup);
    updateReadout();
  }

  function commitCustom(rule) {
    const index = customRules.findIndex((r) => sameTransition(r, rule));
    if (index >= 0) customRules.splice(index, 1);
    customRules.push(rule);
    if (customRules.length > MAX_SAVED) customRules.splice(0, customRules.length - MAX_SAVED);
    writeStorage(customRules);
    renderSavedList();
  }

  function saveDraft() {
    const rule = { ...draftRule(), id: newRuleId(), mode: "life-like" };
    commitCustom(rule);
    loadRule(rule);
    applyDraft();
    toast(`Saved "${rule.name}"`);
  }

  function shareDraft() {
    try {
      const code = shareEncode(draftRule());
      copyToClipboard(code);
      toast("Share code copied to clipboard");
    } catch (err) {
      toast(err.message || "Could not create share code");
    }
  }

  function importCode(raw) {
    if (!raw || !raw.trim()) return;
    try {
      const decoded = shareDecode(raw);
      const rule = {
        id: newRuleId(),
        name: decoded.name || `Imported ${toRuleString(decoded)}`,
        mode: "life-like",
        birth: [...(decoded.birth ?? [])],
        survive: [...(decoded.survive ?? [])],
      };
      commitCustom(rule);
      loadRule(rule);
      onApply(rule);
      updateBadge(rule);
      importInput.value = "";
      importSection.hidden = true;
      toast(`Imported "${rule.name}"`);
    } catch (err) {
      toast(err.message || "Could not import rule");
    }
  }

  function renderSavedList() {
    savedList.textContent = "";
    if (customRules.length === 0) {
      savedList.appendChild(el("span", "re-empty", "No saved rules yet — create one above."));
      return;
    }
    for (const r of customRules) {
      const row = el("div", "re-saved");
      const info = el("button", "re-saved-apply", `${r.name} · ${toRuleString(r)}`);
      info.type = "button";
      info.title = "Apply this saved rule";
      info.addEventListener("click", () => {
        loadRule(r);
        onApply(r);
        updateBadge(r);
        close();
      });
      const share = el("button", "re-saved-share", "Share");
      share.type = "button";
      share.addEventListener("click", () => {
        try {
          copyToClipboard(shareEncode(r));
          toast(`Copied "${r.name}" share code`);
        } catch (err) {
          toast(err.message || "Could not share");
        }
      });
      const del = el("button", "re-saved-del", "🗑");
      del.type = "button";
      del.title = "Delete this saved rule";
      del.addEventListener("click", () => {
        customRules = customRules.filter((x) => x.id !== r.id);
        writeStorage(customRules);
        renderSavedList();
        toast(`Deleted "${r.name}"`);
      });
      row.appendChild(info);
      row.appendChild(share);
      row.appendChild(del);
      savedList.appendChild(row);
    }
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2400);
  }

  function open() {
    syncGrid(birthGroup);
    syncGrid(surviveGroup);
    updateReadout();
    modal.hidden = false;
  }

  function close() {
    modal.hidden = true;
  }

  // ---- Event wiring --------------------------------------------------------
  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);

  nameInput.addEventListener("input", () => {
    draft.name = nameInput.value;
    dirty = true;
  });

  presetSelect.addEventListener("change", () => {
    const rule = presets.find((p) => p.id === presetSelect.value);
    if (rule) {
      loadRule(rule);
      onApply(rule);
      updateBadge(rule);
    }
  });

  // ---- Initial render ------------------------------------------------------
  loadRule(active);
  renderSavedList();
  updateBadge(active);
  applyDraft();

  return {
    root: modal,
    open,
    close,
    updateActive(rule) {
      loadRule(rule);
      onApply(rule);
      updateBadge(rule);
    },
    getActive() {
      return active;
    },
  };
}