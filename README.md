# Game of Life 3D — Scaffold

A runnable 3D Game of Life scaffold built on **Node.js + Vite + three.js**.
This repository is the single shared foundation that later rule-set, skin, and
multiplayer tasks build on, so all shared code lives in stable, engine-agnostic
modules under `src/`.

## Run it

Requirements: Node.js >= 20 and npm.

```bash
npm install     # install three.js + vite
npm run dev     # dev server with HMR  → http://localhost:5173
npm run build   # production build      → dist/
npm start       # preview the production build → http://localhost:4173
```

Open the dev server URL in a browser. You should see a dark 3D scene with an
orbit camera, a drifting grid floor, and a seeded voxel lattice that evolves
under Conway B3/S23 extended to the 26-neighbour 3D Moore neighbourhood. Drag
to orbit, scroll to zoom. The HUD shows the current generation and population.
Use the **Theme** dropdown in the HUD to switch visual skins live (no reload);
the active skin is remembered in localStorage and restored on the next visit.
A prominent **⚙ Rules** button opens the rule editor — create custom
rule-sets, swap between presets (Conway B3/S23, HighLife B36/S23, Seeds B2/S,
Day & Night B3678/S34678, Bays 3D B25/S45), save/load/delete them, and share
them as a compact copy-paste code. Rule changes apply to the running lattice
immediately, no restart needed.

New players see a short **first-run tour** (click **?** next to Step at any
time to re-open it) that anchors tooltips to the camera hint bar, ⚙ Rules,
the Theme selector, the multiplayer room bar, and the Grid control. Each step
renders and dismisses (Next / Got it / Skip tour) and emits `hint:shown` /
`hint:dismissed` usage events. The **Grid** dropdown switches lattice presets
(Small 12³ / Default 16³ / Medium 24³ / Large 32³) and the **Quality** dropdown
picks a detail level; an automatic quality guard lowers detail when the
framerate dips below the interactive threshold (see "Performance" below).

Tests (engine + contracts + multiplayer, no browser needed):

```bash
npm test        # node --test  (glider, blinker, block, initialize/tick,
                # contracts, skins, rules, metrics, quality, onboarding,
                # net/protocol, net/session, net/determinism, net/relay e2e)
```

## End-to-end browser verification

`npm run e2e` boots a Vite dev server **and** the WebSocket relay, opens
Chromium (Playwright), and walks the full delivery-goal scenario:

- launch: canvas renders, generation auto-runs, no console errors;
- simulate: Step / Pause / Resume;
- custom rule: the editor toggles a birth count and the HUD badge shows the
  applied rule (`B35/S23` in the default scenario), `custom-rule:explored`
  fires;
- skins: all registry skins apply with no console errors;
- multiplayer: two windows create/join a room, the guest reaches `joined`,
  the roster shows both peers, snapshots converge (generation > 0 on both),
  and `multiplayer:join` metrics fire on host and guest;
- onboarding: every tour step renders and dismisses;
- fps: readings exist at the default preset and after applying the Large
  (32³) preset.

Run it with the relay available (the script self-hosts it):

```bash
npm install            # includes playwright + downloads its Chromium (first run)
npm run e2e
```

The same scenario is manually verifiable in a real browser: `npm run dev`,
`npm run relay`, open two windows and follow the README flow above. E2E runs
so far cover Chromium; Firefox (via Playwright) follows the same script when a
local Firefox binary is installed (`npx playwright install firefox`).

## Goal metrics (local, anonymized)

The delivery goals — **+20% active play-time** and **≥5% of sessions explore a
custom rule-set** — are measurable through a deliberately **local, anonymized**
event sink. There is **no external analytics service**: events are written to
`console.debug`, appended to a bounded `localStorage` queue
(`game-of-life-3d:metrics`), and dispatched as `life3d:metric` CustomEvents.
Open DevTools → Console, or run `localStorage.getItem("game-of-life-3d:metrics")`
from the console to dump the sink. The live reporter is exposed as
`window.__life3dMetrics` (`getSummary()`, `getEvents()`, `flush()`).

| Event | Fields | Meaning |
| --- | --- | --- |
| `session:start` | `sessionId` | New session opened. |
| `session:end` | `durationMs`, `activeMs` | Session closed; active time is the sum of seconds the simulation ran (`handle.isRunning()`). |
| `custom-rule:explored` | `ruleId`, `ruleName` | Flag: a non-default rule-set became active (once per rule per session). |
| `skin:switch` | `skinId`, `skinLabel` | A skin change. |
| `multiplayer:join` | `role`, `roomCode` | Join/create a room. |
| `grid:preset` | `size`, `id` | Grid-size preset applied. |
| `hint:shown` / `hint:dismissed` | `step` | Onboarding tour step shown/dismissed. |
| `quality:guard` | `level`, `levelId`, `reason`, `fps` | Automatic (or manual) quality degradation. |

Goal formulas (per session, using the exported sink):

- **Active play-time %** = `Σ activeMs` ÷ `Σ durationMs` across `session:end`
  events. Target: the "before" baseline plus ≥20% more _active_ play-time.
- **Custom-rule session %** = sessions with ≥1 `custom-rule:explored` event ÷
  sessions with ≥1 `session:start` event. Target: ≥5%.

No personal data is stored: only counts, durations, and ids already visible in
the app (skin ids, room codes, rule ids). Everything stays on the user's
machine.

## Multiplayer (authoritative-host rooms)

The scaffold ships a self-hosted multiplayer layer (`src/net/session.js` +
`server/relay.js`) built on **native WebSocket** — no managed service, no
external dependencies beyond the existing `ws` package (Node >= 20 also has a
global `WebSocket` for the client path).

Start the relay in one terminal:

```bash
npm run relay   # WebSocket relay on ws://localhost:8787/ws
```

Then open two browser windows on the same dev server:

1. In window A click **Create room**. A shareable room code appears along with
   a **Copy link** button.
2. In window B click **Join** and type the code (or open the copied
   `?room=CODE` link — it auto-joins).
3. Both windows render the **same 3D lattice**: the host runs the deterministic
   phase-1 simulation, ticks it at the room rate, and broadcasts full/delta
   world snapshots. Joiners apply snapshots and never tick on their own.
4. Any player can **✏ Seed mode** (click a voxel to place/remove it), **Pause**,
   **Resume**, **Step**, **Clear**, switch **rule-sets**, or switch **skin** —
   every request is validated by the host and broadcast to every client within
   one tick cycle.
5. Remote players appear as labeled cone markers in the scene, following their
   cursor while they hover over the lattice.
6. Close/kill the host window: the relay hands authority to the oldest
   remaining client, which restores the latest cached snapshot (`fromSnapshot`),
   resumes ticking, and the world continues without grid divergence.

Design rules that keep the sync coherent:

- **Host-authoritative determinism**: same seed + rule + tick count produce
  identical world state (the engine is untouched), so every client renders
  identical grids.
- **Caps**: grid size is capped at `MAX_GRID_SIZE` (32), tick rate at
  `MAX_TICK_RATE` (8/s, default 4), peers at `MAX_ROOM_CLIENTS` (8), and
  messages are size/rate limited.
- **Delta thresholds**: full snapshots are sent below `DELTA_THRESHOLD` live
  cells; large lattices use sparse deltas so sync degrades (fewer bytes), not
  diverges.

## Module layout

```
index.html                3D canvas host + minimal HUD (module entry)
src/
  index.js                 Entrypoint: boots the demo, exposes window hooks
  main.js                  Bootstrap: simulation + scene wiring and play loop
  engine/
    simulation.js          Pure 3D state engine (no DOM / three.js imports)
    patterns.js            Named patterns (glider, blinker, block) + helpers
    rules.js               Rule-set engine: B/S parsing, presets, share codes
    rules.test.js          Rule-set engine tests
  ui/
    rules-editor.js        Rule editor panel (HUD entry point, presets,
                           custom editor, saved rules, share/import)
  contracts/
    index.js               Barrel exports for later tasks
    simulation.js          Shared world constants (SIZE, SEED_DENSITY, SPEED)
    ruleSet.js             Rule-set schema + validators (B3/S23 default)
    worldState.js          World/cell state shape + snapshot validators
    skin.js                Skin/theme contract + default skin
  scene/
    scene.js               three.js renderer: camera, lights, voxel lattice
  skins/
    skins.js               Skin registry (3+ themes; contract-validated)
    skins.test.js          Registry/panel tests (node --test)
  ui/
    skins-panel.js         HUD skin selector + localStorage persistence
  net/
    protocol.js            Pure wire protocol: room codes, actions, diffs
    session.js             Multiplayer session (authoritative-host model)
    protocol.test.js       Protocol/session headless tests
    determinism.test.js    Determinism + no-divergence tests
    relay.test.js          End-to-end relay tests (real WebSocket)
  ui/
    multiplayer-panel.js   HUD room bar: create/join, roster, seed/control
    onboarding.js          First-run tour tooltips + persistence (+ test)
    grid-control.js        HUD Grid preset + Quality + FPS readout
  analytics/
    metrics.js             Local/anonymized usage events (+ test)
  quality/
    quality.js             Grid presets, FPS meter, quality guards (+ test)
  engine/
    simulation.test.js     Engine + pattern tests (node --test)
  contracts/
    contracts.test.js      Schema/validator/tests
server/
  relay.js                 WebSocket relay (`npm run relay`) + room cache
```

## Simulation engine

`src/engine/simulation.js` is a pure, headless state engine:

- `createSimulation({ size = 16, seedDensity = 0.2, seed? })`
- `sim.getCell(x, y, z)` — live? (0/1)
- `sim.setCell(x, y, z, alive)` — paint a cell
- `sim.tick(ruleSet?)` — advance one generation, returns new population
- `sim.initialize(seedDensity?)` — re-seed randomly
- `sim.clear()` — empty lattice
- `sim.resize(newSize)` — rebuild the lattice at a new cubic size; cells
  inside the new bounds keep their state, out-of-bounds cells are dropped
  (grid-size presets use this; the transition rule-set is untouched)
- `sim.toSnapshot()` / `sim.fromSnapshot(snapshot)` — persistence / multiplayer sync
- `sim.generation`, `sim.size`, `sim.population`

The lattice is a cube centered on the origin, `size` cells per axis; cells are
either 0 (dead) or 1 (alive). Edges are hard walls (no wrap-around). By default
the neighbourhood is the full 26-cell Moore set in 3D.

**Rules.** The default rule-set is classic Conway B3/S23 lifted to 3D. A
rule-set object (contracts/ruleSet.js) may also set `plane`/`planeOffset` to
constrain evolution to a classic 2D plane inside the 3D lattice (8 in-plane
neighbours) — this is how the original 2D demo behaviour is preserved and how
`window.gameOfLifeStep` implements glider-test.html. `src/engine/rules.js`
owns the pure rule concerns: the 26-neighbour Moore set, five built-in
presets, B/S notation ("B3/S23", "B36/S23", "B2/S") extended with A..Q for
counts 10..26, and compact share codes (`life3d:rule:…`) that round-trip a
whole named rule-set. The scene bootstrap (`main.js`) passes the active
rule-set to every `tick`, so swapping rule-sets changes behaviour at runtime.

## Contracts for later tasks

- `src/contracts/ruleSet.js` — schema + validators + `DEFAULT_RULE_SET`; custom
  rule-sets can implement `tick(world, getCell) => Map`.
- `src/contracts/worldState.js` — `{ generation, size, cells: [x,y,z,0|1][] }`
  shape used by snapshots and multiplayer sync.
- `src/contracts/skin.js` — theme contract `{ id, label, description, color,
  emissive, background }` consumed by the renderer.
- `src/contracts/simulation.js` — shared world constants (`SIZE`,
  `SEED_DENSITY`, `SPEED`).

## Visual skins

`src/skins/skins.js` registers the visual themes. Each entry is a superset of
the phase-1 `src/contracts/skin.js` contract (`id/label/description/color/
emissive/background`) plus renderer fields (`style`, `backgroundTop`, `fog`,
`grid`, `lights`, `palette`, `cell`). Three skins ship by default:

- **Classic Voxels** — solid amber cubes with warm per-cell age tinting.
- **Neon Wireframe** — emissive wireframe cages plus additive glow bloom.
- **Organic** — rounded, soft cells with an ambient green tint.

Live cells are instanced (one draw call per skin), so all three skins stay
interactive at the default 16×16×16 lattice. The HUD `Theme` dropdown swaps
skins live; switching never restarts or corrupts the simulation (pattern and
generation counter are untouched). Choice persists in
`localStorage["game-of-life-3d:active-skin"]`.

Dying/fading cells are drawn as a short-lived "ghost" layer in each skin's
`palette.dying` color, and cells that live longer drift through the skin's
`palette.young → mid → old` age tint — both are cosmetic layers on top of the
pure engine, so they cannot alter simulation state.

## Performance, presets and quality guards

Live cells are rendered with **one instanced draw call per skin**
(`THREE.InstancedMesh`), so the default 16³ lattice stays interactive across
all three skins. The HUD **Grid** dropdown adds size presets
(Small 12³ / Default 16³ / Medium 24³ / Large 32³); the **Quality** dropdown
picks a detail level (High / Medium / Low). An automatic quality guard in
`src/quality/quality.js` samples the render loop every second and, when the
framerate drops below the interactive threshold (`INTERACTIVE_FPS`, 45),
steps down one level (pixel-ratio cap → ghost-layer toggles → particle
budget) and emits `quality:guard`. Grid changes go through the pure engine
API (`sim.resize`), so the deterministic tick contract is unchanged.

Known performance caps (single-player and multiplayer):

- Grid size is capped at `MAX_GRID_SIZE` (**32**) — the 32³ preset is the
  largest lattice; 24³ is the recommended "playable large" preset on
  integrated GPUs.
- In software rendering (e.g. SwiftShader headless environments) the guard
  immediately drops to Low; on real GPUs the default preset runs at 60 FPS
  and Large stays playable via instancing plus the Low-quality guard.
- Multiplayer adds relay + snapshot cost: the host caps tick rate at
  `MAX_TICK_RATE` (8/s, default 4) and uses sparse deltas above
  `DELTA_THRESHOLD` live cells so sync degrades gracefully instead of
  diverging.
- FPS readout lives in the HUD (`#fps-stat`) and is exposed via
  `window.__life3dQuality.getFps()` / `getLastGuard()`.

## Onboarding

On first visit, a dismissible tour anchors tooltips to the camera hint bar,
**⚙ Rules**, the **Theme** selector, the multiplayer room bar, and the **Grid**
control. Use **Next** / **Back** to walk the steps, **Got it** to finish, or
**Skip tour** to dismiss; the completion state persists in
`localStorage["game-of-life-3d:onboarding-v1"]`. The **?** button next to
Step re-opens the tour on demand. Each step emits `hint:shown` /
`hint:dismissed` usage events (`step` field) so onboarding coverage is
measurable.

## Backward compatibility

`glider-test.html` still works unchanged: the demo exposes the classic pure
2D `window.gameOfLifeStep(cells)` hook (glider, blinker, and block pass).
The `window.__life3d` handle now exposes `setSkin(id)`, `start/stop/step/
reset`, `dispose`, `simulation` and `activeSkinId` so HMR and tests can drive
the same runtime without reloading the page.

## Notes for contributors

- The simulation core must stay pure: **no DOM or three.js imports** in
  `src/engine/**` or `src/contracts/**`.
- `src/main.js` and `src/scene/scene.js` are the only DOM/three.js glue.
- `src/net/protocol.js` is the pure wire-protocol layer (no DOM/network
  imports); `src/net/session.js` is browser-first but deliberately keeps all
  protocol concerns in `protocol.js` so headless tests can drive it through a
  fake socket. `server/relay.js` is a Node-only relay (uses `ws`).
- Keep shared world constants in `src/contracts/simulation.js`; phase-2 tasks
  should consume them instead of redefining dimensions.
- Multiplayer never forks or modifies the simulation core: the host owns
  `sim.tick`, joiners only `fromSnapshot`, and every action is validated
  through `src/net/protocol.js` before broadcast.
- The metrics reporter stays local/anonymized: it never performs a network
  request and stores only bounded, anonymous counts in
  `localStorage["game-of-life-3d:metrics"]` (see "Goal metrics").
- Browser verification hooks: `window.__life3d` (simulation + scene handle),
  `window.__life3dSession`, `window.__life3dMetrics`,
  `window.__life3dQuality`, `window.__life3dGridPanel`, and
  `window.__life3dOnboarding`.