# Game of Life — Interactive Single-File Build

Build **Conway's Game of Life** as a single, self-contained `index.html` file.
It must be visually polished and interactive enough to feature on a public marketing page.

## Hard constraints (auto-fail if violated)

- **One file only**: everything (HTML, CSS, JS) lives in `index.html`.
- **Zero network requests**: no CDNs, no external fonts, no images, no `fetch`. Must run from `file://` offline.
- **No build step**: opening the file in a browser just works.
- **No frameworks or libraries.** Vanilla JS + Canvas (or SVG). System fonts only.
- Ship clean, readable JavaScript — no dead code, no console errors.

## Core requirements (the gate — these must all work)

1. A grid rendered on `<canvas>`, default ~60×40 cells, sized responsively to the viewport.
2. **Correct Conway rules (B3/S23)**: a live cell with 2–3 live neighbours survives; a dead cell with exactly 3 live neighbours is born; everything else dies or stays dead. 8-neighbour (Moore) adjacency.
3. **Play / Pause** and **single Step** controls.
4. **Draw**: click *and drag* to toggle/paint cells while paused.
5. **Clear** and **Randomize** controls.
6. Smooth animation at the default speed with no visible stutter on a 60×40 grid.

### Correctness acceptance test (the build must pass this)

Place a single **glider** at the top-left:

```
.X.
..X
XXX
```

Run the simulation. After **4 generations** the glider must be identical in shape but translated exactly **+1 cell right and +1 cell down**. After 20 generations it must have moved +5/+5 and still be intact. If the glider deforms or stalls, the rules are wrong — this is a hard fail.

### Automated grading hook (optional, recommended)

To allow `glider-test.html` to verify your rules automatically, expose your step logic as a **pure function** on the global scope:

```js
// cells: 2D array, cells[row][col] === 1 (alive) or 0 (dead)
// returns: a new 2D array of the same dimensions = the next generation
window.gameOfLifeStep = function (cells) { /* ... */ };
```

It must not mutate the input. Edge behaviour (hard walls or toroidal wrap) is your choice — the test keeps the glider far from the edges so either is fine. This hook is optional and does not affect the rendered app; it only enables one-click correctness checking.

## Weighted quality rubric (score out of 100)

Implement as many as you can, prioritising correctness and polish over raw feature count.

### A. Correctness — 30 pts
- 20 — Passes the glider acceptance test exactly.
- 10 — Edge behaviour is deliberate and stated (either hard walls *or* toroidal wrap), with no off-by-one neighbour-counting bugs.

### B. Core interactivity — 20 pts
- 8 — Play / Pause / Step all work and feel responsive.
- 6 — Click-and-drag painting (and drag-to-erase) while paused.
- 6 — Clear + Randomize (randomize at a sensible ~25–35% density).

### C. Features & depth — 25 pts
- 8 — **Pattern library**: a menu to stamp at least 4 known patterns (e.g. Glider, Lightweight Spaceship, Pulsar, Gosper Glider Gun) onto the grid.
- 5 — **Speed control** (slider or presets) from slow to fast.
- 4 — **Toroidal wrap toggle** (edges wrap around).
- 4 — **Live stats**: generation counter + current population.
- 4 — **Shareable / persistable state**: encode the board in the URL hash or `localStorage` so a layout survives reload.

### D. Visual design & polish — 15 pts
- 6 — Cohesive, modern palette with a proper dark theme; tasteful header and control layout (not default browser buttons).
- 5 — Pleasing cell rendering: crisp grid, optional subtle fade/trail or birth/death animation.
- 4 — Considered typography, spacing, and a short inline "how to use" hint.

### E. Robustness & UX — 10 pts
- 4 — Responsive: usable on a phone, including **touch** painting.
- 3 — Handles a large grid (e.g. 200×120) without freezing.
- 2 — Keyboard shortcuts (e.g. Space = play/pause, → = step, C = clear, R = randomize).
- 1 — No console errors or warnings.

## Deliverable

A single `index.html` that, opened in any modern browser, presents a finished, attractive, fully interactive Game of Life meeting the above. Optimise for a screenshot that looks production-ready.

---

### Verifying correctness locally

`glider-test.html` runs the glider acceptance test. For best results serve the folder over HTTP so it can read `index.html`'s optional grading hook:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/glider-test.html
```

If `window.gameOfLifeStep` is exposed, the harness tests your implementation directly. Otherwise it falls back to verifying the reference rules so you can see exactly what "correct" looks like.

---

## How to Run

The app is a single self-contained `index.html` with no build step. Launch a local server with:

```bash
npm start
```

This runs `npx serve -l 3000 .` and serves the project at **http://localhost:3000**. Open that URL in any modern browser to start the simulation.

> No `npm install` is required — `npm start` fetches `serve` on demand via `npx`.

**Offline alternative:** because the file is fully self-contained, you can also open `index.html` directly from disk (`file://`) in a browser and it will work without a server.

## Features

The simulation ships with the following controls (shown in the toolbar above the grid):

| Control | Action |
| --- | --- |
| **Start** | Begins auto-advancing the simulation generation by generation. |
| **Stop** | Pauses the auto-advance; the grid stays editable while stopped. |
| **Step** | Advances exactly one generation while paused. |
| **Reset** | Restores the grid to the default seed pattern (the glider). |
| **Clear** | Empties the grid entirely (all cells dead). |
| **Speed** | Slider that sets the delay between generations (shown in ms); slide left for slower, right for faster. |

**Drawing:** while stopped, click and drag on the grid to toggle cells on/off.

**Default seed:** on load (and after **Reset**) the grid is seeded with a single **glider** in the top-left area, so the simulation is ready to run immediately:

```
.X.
..X
XXX
```
