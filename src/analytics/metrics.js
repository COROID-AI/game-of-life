/**
 * Lightweight, local, anonymized usage metrics for the 3D Game of Life.
 *
 * Delivery goals ("+20% active play-time", "≥5% of sessions explore custom
 * rule-sets") need to be measurable without any external analytics service.
 * This module implements a tiny event sink that stays local to the machine:
 *
 *   - every event is written to `console.debug` (browser devtools),
 *   - events are appended to a bounded localStorage queue
 *     (`game-of-life-3d:metrics`) so a QA run can dump the local event sink,
 *   - the live handle is exposed on `window.__life3dMetrics`, and
 *   - each event is dispatched as a `life3d:metric` CustomEvent on `window`.
 *
 * The reporter is intentionally pure and headless-safe: `window`,
 * `localStorage`, and `performance` are all accessed defensively so the same
 * module runs under `node --test` (Node) and in the browser. No personal data
 * is collected — only counts, durations, and ids already visible in the app,
 * and no network request is ever made.
 *
 * Metric definitions:
 *   session:start                      { sessionId }                     — new session opened
 *   session:end                        { durationMs, activeMs }          — session closed
 *   custom-rule:explored               { ruleId, ruleName }              — flag: a non-default
 *                                                                          rule-set became active
 *   skin:switch                        { skinId, skinLabel }             — count of skin switches
 *   multiplayer:join                   { role, roomCode }                — joined/created a room
 *   grid:preset                        { size }                          — grid preset applied
 *   hint:shown / hint:dismissed        { step }                          — onboarding tour step
 *   quality:guard                      { level, reason, fps }            — auto quality guard hit
 *
 * Goals mapping (documented in README):
 *   active play-time   = sum(session:end.activeMs) across sessions
 *   custom-rule rate   = sessions with ≥1 custom-rule:explored event ÷ sessions
 */

/**
 * Canonical metric event names.
 * @readonly
 */
export const METRIC_EVENTS = Object.freeze({
  SESSION_START: "session:start",
  SESSION_END: "session:end",
  CUSTOM_RULE_EXPLORED: "custom-rule:explored",
  SKIN_SWITCH: "skin:switch",
  MULTIPLAYER_JOIN: "multiplayer:join",
  GRID_PRESET: "grid:preset",
  HINT_SHOWN: "hint:shown",
  HINT_DISMISSED: "hint:dismissed",
  QUALITY_GUARD: "quality:guard",
});

/** Default localStorage key used as the durable local event sink. */
export const DEFAULT_STORAGE_KEY = "game-of-life-3d:metrics";

/** Maximum number of events kept in the localStorage queue. */
export const MAX_QUEUED_EVENTS = 500;

function safeStorage() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function safeNow() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

/** Read the current localStorage queue, tolerant of missing/corrupt data. */
export function readQueuedEvents(storage = safeStorage(), key = DEFAULT_STORAGE_KEY) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-MAX_QUEUED_EVENTS) : [];
  } catch {
    return [];
  }
}

/** Persist a bounded queue of events to localStorage. */
export function writeQueuedEvents(events, storage = safeStorage(), key = DEFAULT_STORAGE_KEY) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(events.slice(-MAX_QUEUED_EVENTS)));
    return true;
  } catch {
    return false; // private mode / quota — metrics still reach console + window
  }
}

/**
 * Create a metrics reporter bound to one session.
 * @param {Object} [options]
 * @param {string} [options.sessionId] Stable id for the session (default: random).
 * @param {string} [options.storageKey] localStorage sink key.
 * @param {boolean} [options.console] Whether to mirror events to console.debug.
 * @param {Function} [options.onEvent] Optional side-channel hook (UI/HUD wiring).
 * @param {Object} [options.storage] Optional storage backend (localStorage-like);
 *   defaults to safeStorage() — injectable for tests and Node environments.
 * @returns {{ start: Function, end: Function, record: Function, addActiveTime:
 *   Function, getEvents: Function, getSummary: Function, getSessionId:
 *   Function, getActiveMs: Function, flush: Function }}
 */
export function createMetrics(options = {}) {
  const sessionId =
    options.sessionId ??
    `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const storage = options.storage !== undefined ? options.storage : safeStorage();
  const consoleMirror = options.console !== false;
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : null;

  const events = [];
  let startedAt = safeNow();
  let activeMs = 0;
  let lastActiveSample = safeNow();
  let ended = false;

  const customRuleExplored = new Set(); // anonymous rule ids seen this session

  /** Enqueue + fan-out one event to every local sink. */
  function record(event, fields = {}) {
    if (ended && event !== METRIC_EVENTS.SESSION_END) return;
    const entry = {
      name: event,
      ts: new Date().toISOString(),
      sessionId,
      ...fields,
    };
    events.push(entry);

    if (consoleMirror) {
      try {
        // eslint-disable-next-line no-console
        console.debug(`[life3d-metrics] ${event}`, fields);
      } catch {
        // ignore console failures
      }
    }
    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(
          new CustomEvent("life3d:metric", { detail: { ...entry } }),
        );
      } catch {
        // no window (node) — skip
      }
    }
    writeQueuedEvents(
      [...readQueuedEvents(storage, storageKey), entry],
      storage,
      storageKey,
    );
    if (onEvent) {
      try {
        onEvent({ ...entry });
      } catch {
        // hooks must not break metrics
      }
    }
    return entry;
  }

  /** Accumulate active (simulation-running) time, called from the UI loop. */
  function addActiveTime(ms) {
    if (ended || !Number.isFinite(ms) || ms <= 0) return activeMs;
    activeMs += ms;
    return activeMs;
  }

  /** Open the session (fires session:start once). */
  function start() {
    if (ended) return;
    startedAt = safeNow();
    lastActiveSample = startedAt;
    record(METRIC_EVENTS.SESSION_START);
  }

  /** Close the session (fires session:end with duration + active time). */
  function end() {
    if (ended) return false;
    ended = true;
    const durationMs = Math.max(0, safeNow() - startedAt);
    record(METRIC_EVENTS.SESSION_END, {
      durationMs: Math.round(durationMs),
      activeMs: Math.round(activeMs),
    });
    return true;
  }

  /** Record custom-rule exploration once per session (flag semantics). */
  function recordCustomRule(ruleSet) {
    if (!ruleSet) return false;
    const key = ruleSet.id || JSON.stringify([ruleSet.birth, ruleSet.survive]);
    if (customRuleExplored.has(key)) return false;
    customRuleExplored.add(key);
    record(METRIC_EVENTS.CUSTOM_RULE_EXPLORED, {
      ruleId: ruleSet.id ?? "custom",
      ruleName: ruleSet.name ?? "Custom",
    });
    return true;
  }

  return {
    start,
    end,
    record,
    addActiveTime,
    recordCustomRule,
    getEvents: () => events.map((e) => ({ ...e })),
    getSessionId: () => sessionId,
    getActiveMs: () => Math.round(activeMs),
    flush: () => {
      const queued = readQueuedEvents(storage, storageKey);
      writeQueuedEvents([], storage, storageKey);
      return queued;
    },
    getSummary() {
      const byName = {};
      for (const e of events) byName[e.name] = (byName[e.name] ?? 0) + 1;
      return {
        sessionId,
        startedAt,
        durationMs: Math.round(safeNow() - startedAt),
        activeMs: Math.round(activeMs),
        events: byName,
      };
    },
  };
}