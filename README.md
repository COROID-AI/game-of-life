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

Tests (engine + contracts, no browser needed):

```bash
npm test        # node --test  (glider, blinker, block, initialize/tick, contracts)
```

## Module layout

```
index.html                3D canvas host + minimal HUD (module entry)
src/
  index.js                 Entrypoint: boots the demo, exposes window hooks
  main.js                  Bootstrap: simulation + scene wiring and play loop
  engine/
    simulation.js          Pure 3D state engine (no DOM / three.js imports)
    patterns.js            Named patterns (glider, blinker, block) + helpers
  contracts/
    index.js               Barrel exports for later tasks
    simulation.js          Shared world constants (SIZE, SEED_DENSITY, SPEED)
    ruleSet.js             Rule-set schema + validators (B3/S23 default)
    worldState.js          World/cell state shape + snapshot validators
    skin.js                Skin/theme contract + default skin
  scene/
    scene.js               three.js renderer: camera, lights, voxel lattice
  engine/
    simulation.test.js     Engine + pattern tests (node --test)
  contracts/
    contracts.test.js      Schema/validator/tests
```

## Simulation engine

`src/engine/simulation.js` is a pure, headless state engine:

- `createSimulation({ size = 16, seedDensity = 0.2, seed? })`
- `sim.getCell(x, y, z)` — live? (0/1)
- `sim.setCell(x, y, z, alive)` — paint a cell
- `sim.tick(ruleSet?)` — advance one generation, returns new population
- `sim.initialize(seedDensity?)` — re-seed randomly
- `sim.clear()` — empty lattice
- `sim.toSnapshot()` / `sim.fromSnapshot(snapshot)` — persistence / multiplayer sync
- `sim.generation`, `sim.size`, `sim.population`

The lattice is a cube centered on the origin, `size` cells per axis; cells are
either 0 (dead) or 1 (alive). Edges are hard walls (no wrap-around). By default
the neighbourhood is the full 26-cell Moore set in 3D.

**Rules.** The default rule-set is classic Conway B3/S23 lifted to 3D. A
rule-set object (contracts/ruleSet.js) may also set `plane`/`planeOffset` to
constrain evolution to a classic 2D plane inside the 3D lattice (8 in-plane
neighbours) — this is how the original 2D demo behaviour is preserved and how
`window.gameOfLifeStep` implements glider-test.html.

## Contracts for later tasks

- `src/contracts/ruleSet.js` — schema + validators + `DEFAULT_RULE_SET`; custom
  rule-sets can implement `tick(world, getCell) => Map`.
- `src/contracts/worldState.js` — `{ generation, size, cells: [x,y,z,0|1][] }`
  shape used by snapshots and multiplayer sync.
- `src/contracts/skin.js` — theme contract `{ id, label, description, color,
  emissive, background }` consumed by the renderer.
- `src/contracts/simulation.js` — shared world constants (`SIZE`,
  `SEED_DENSITY`, `SPEED`).

## Backward compatibility

`glider-test.html` still works unchanged: the demo exposes the classic pure
2D `window.gameOfLifeStep(cells)` hook (glider, blinker, and block pass).
The 3D scene itself keeps the old "neon voxel" aesthetic while exposing the
foundation that later tasks extend.

## Notes for contributors

- The simulation core must stay pure: **no DOM or three.js imports** in
  `src/engine/**` or `src/contracts/**`.
- `src/main.js` and `src/scene/scene.js` are the only DOM/three.js glue.
- Keep shared world constants in `src/contracts/simulation.js`; phase-2 tasks
  should consume them instead of redefining dimensions.