/**
 * three.js scene renderer for the Game of Life lattice.
 *
 * Phase-2 skin system: the renderer consumes skin registry entries from
 * src/skins/skins.js and rebuilds its visual layer whenever the skin changes —
 * cell geometry + material, lights, background gradient, fog and grid floor.
 * The shared simulation handle is never touched by a skin switch, so the cell
 * pattern and generation counter keep running unchanged.
 *
 * Per-skin visuals:
 *   - voxel     : solid cubes with warm per-cell age tinting
 *   - wireframe : emissive wireframe cages + additive glow billboards
 *   - organic   : rounded, slightly varied cells with a soft material
 *
 * Performance: every live cell is drawn by a single draw call using
 * THREE.InstancedMesh; buffers are only rewritten when the lattice or skin
 * changes. Dying "ghost" fades are a small second InstancedMesh rebuilt per
 * frame (typically tens of items).
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { getSkin, getSkins, DEFAULT_SKIN_ID } from "../skins/skins.js";

/** Dying fade duration in ms (cosmetic layer; does not affect the engine). */
export const DYING_FADE_MS = 1200;

/** Instances per InstancedMesh allocation (per particle draw call). */
const INSTANCE_CHUNK = 256;

const FRAME_MATRIX = new THREE.Matrix4();
const FRAME_POSITION = new THREE.Vector3();
const FRAME_QUAT = new THREE.Quaternion();
const FRAME_SCALE = new THREE.Vector3();

const GRID_COLOR_1 = new THREE.Color();
const GRID_COLOR_2 = new THREE.Color();
const PALETTE_END = new THREE.Color();
const CELL_COLOR = new THREE.Color();
const DYING_COLOR = new THREE.Color();
const PEER_COLOR = new THREE.Color();

/** Remote presence marker geometry (a small cone pointing up at the cell). */
const PEER_MARKER_GEOMETRY = new THREE.ConeGeometry(0.16, 0.34, 8);

/** Strength of a sine wave of period `period` at time t (seconds), 0..1. */
function wave(t, period) {
  return 0.5 + 0.5 * Math.sin((t / period) * Math.PI * 2);
}

/** Age (in ticks) → 0..1; cells that lived >= 60 ticks stay at the "old" end. */
function ageNormalized(ticks) {
  return Math.min(1, Math.max(0, ticks / 60));
}

/** A 1x1 white radial texture used by the additive glow billboards. */
function makeGlowTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** Build a vertical gradient texture for the scene background (bottom→top). */
function makeBackgroundTexture(bottomHex, topHex) {
  const height = 256;
  const width = 64;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, height, 0, 0);
  const bottom = new THREE.Color(bottomHex);
  const top = new THREE.Color(topHex);
  gradient.addColorStop(0, `#${bottom.getHexString()}`);
  gradient.addColorStop(1, `#${top.getHexString()}`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Rebuild a GridHelper's baked color attribute from two line colors. */
function restyleGrid(grid, color1Hex, color2Hex, divisions) {
  const colors = grid.geometry.getAttribute("color");
  if (!colors) return;
  GRID_COLOR_1.set(color1Hex);
  GRID_COLOR_2.set(color2Hex);
  const center = divisions / 2;
  const a = colors.array;
  for (let i = 0; i <= divisions; i++) {
    const c = i === center ? GRID_COLOR_1 : GRID_COLOR_2;
    const base = i * 4 * 3;
    for (let v = 0; v < 4; v++) {
      a[base + v * 3] = c.r;
      a[base + v * 3 + 1] = c.g;
      a[base + v * 3 + 2] = c.b;
    }
  }
  colors.needsUpdate = true;
}

/**
 * Create and attach a 3D scene to a container element.
 * @param {HTMLElement} container Element that hosts the renderer canvas.
 * @param {Object} options `{ simulation, skinId? }`
 * @returns {Object} `{ renderer, scene, camera, controls, render, syncVoxels,
 *   applySkin, onResize, dispose }`
 */
export function createScene(container, options) {
  const simulation = options.simulation;
  const initialSkinId = options.skinId ?? DEFAULT_SKIN_ID;

  if (!simulation || typeof simulation.getCell !== "function") {
    throw new TypeError("createScene requires a simulation handle with getCell()");
  }
  if (!container || typeof container.appendChild !== "function") {
    throw new TypeError("createScene requires a DOM container element");
  }

  const size = simulation.size;
  const divisions = size;
  const maxCells = Math.min(size * size * size, 8192);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070d);

  const camera = new THREE.PerspectiveCamera(
    55,
    container.clientWidth / container.clientHeight,
    0.1,
    500,
  );
  const extent = size / 2 + 2.5;
  camera.position.set(extent * 1.4, extent * 1.1, extent * 1.4);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  // ---- Environment layers (rebuilt on skin switch) -----------------------------
  const environment = new THREE.Group();
  scene.add(environment);

  const bgSphere = new THREE.Mesh(
    new THREE.SphereGeometry(220, 16, 12),
    new THREE.MeshBasicMaterial({ fog: false, depthWrite: false }),
  );
  bgSphere.renderOrder = -1;
  bgSphere.frustumCulled = false;
  bgSphere.material.side = THREE.BackSide;
  environment.add(bgSphere);

  const grid = new THREE.GridHelper(size, divisions, 0x334466, 0x1c2740);
  grid.position.y = -size / 2 - 1;
  grid.raycast = () => {};
  environment.add(grid);

  const axes = new THREE.AxesHelper(size / 2);
  axes.position.set(0, -size / 2 - 1, 0);
  axes.raycast = () => {};
  environment.add(axes);

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
  keyLight.position.set(20, 30, 15);
  const fillLight = new THREE.DirectionalLight(0x8899ff, 0.35);
  fillLight.position.set(-15, -10, -20);
  environment.add(ambient, keyLight, fillLight);

  // ---- Live-cell layer: one InstancedMesh (+ optional glow) per skin ------------
  const styleGroup = new THREE.Group();
  scene.add(styleGroup);

  let liveMesh = null;
  let liveGlow = null; // THREE.Points when the skin uses bloom
  let liveSkinId = null;

  let geometryDirty = true; // live buffers need a refresh

  // Age/dying bookkeeping (cosmetic only — the engine stays untouched).
  const cellAges = new Map(); // "x,y,z" -> ticks lived
  let lastLiveKeys = null;

  /** Dispose the current per-skin live layer. */
  function disposeLiveLayer() {
    if (liveMesh) {
      styleGroup.remove(liveMesh);
      liveMesh.geometry.dispose();
      liveMesh.material.dispose();
      liveMesh = null;
    }
    if (liveGlow) {
      styleGroup.remove(liveGlow);
      if (liveGlow.material.map) liveGlow.material.map.dispose();
      liveGlow.material.dispose();
      liveGlow.geometry.dispose();
      liveGlow = null;
    }
    liveSkinId = null;
  }

  /** Instances an InstancedMesh allocation can hold. */
  function meshCapacity(mesh) {
    return mesh ? mesh.instanceMatrix.count : 0;
  }

  /** Build a fresh live layer (geometry + material) for a skin definition. */
  function buildLiveLayer(skinDef, capacityArg) {
    const style = skinDef.style;
    const capacity = Math.max(capacityArg ?? INSTANCE_CHUNK, INSTANCE_CHUNK);

    const geometry =
      style === "organic"
        ? new THREE.SphereGeometry(skinDef.cell.size * 0.46, 9, 7)
        : new THREE.BoxGeometry(skinDef.cell.size, skinDef.cell.size, skinDef.cell.size);

    const material =
      style === "wireframe"
        ? new THREE.MeshBasicMaterial({
            color: new THREE.Color(skinDef.color),
            wireframe: true,
            transparent: true,
            opacity: 0.95,
          })
        : new THREE.MeshStandardMaterial({
            color: new THREE.Color(skinDef.color),
            emissive: new THREE.Color(skinDef.emissive),
            emissiveIntensity: style === "organic" ? 0.3 : 0.35,
            roughness: style === "organic" ? 0.8 : 0.45,
            metalness: style === "organic" ? 0.02 : 0.05,
          });

    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    styleGroup.add(mesh);

    let glowPoints = null;
    if (skinDef.cell?.bloom) {
      glowPoints = new THREE.Points(
        new THREE.BufferGeometry(),
        new THREE.PointsMaterial({
          color: new THREE.Color(skinDef.color),
          map: makeGlowTexture(),
          size: 3.2,
          sizeAttenuation: true,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: 0.22,
        }),
      );
      glowPoints.frustumCulled = false;
      glowPoints.geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(capacity * 3), 3),
      );
      styleGroup.add(glowPoints);
    }

    liveMesh = mesh;
    liveGlow = glowPoints;
    liveSkinId = skinDef.id;
  }

  /** Write one per-instance matrix for a live/ghost cell. */
  function writeInstanceMatrix(mesh, index, x, y, z, scaleX = 1, scaleY = 1, scaleZ = 1) {
    FRAME_POSITION.set(x, y, z);
    FRAME_QUAT.identity();
    FRAME_SCALE.set(scaleX, scaleY, scaleZ);
    FRAME_MATRIX.compose(FRAME_POSITION, FRAME_QUAT, FRAME_SCALE);
    mesh.setMatrixAt(index, FRAME_MATRIX);
  }

  /** Snapshot with per-cell age ticks (coordinate order = snapshot order). */
  function snapshotWithAges() {
    const snapshot = simulation.toSnapshot();
    const items = snapshot.cells;
    for (const cell of items) {
      const key = `${cell[0]},${cell[1]},${cell[2]}`;
      cell[3] = cellAges.get(key) ?? 0;
    }
    return items;
  }

  /** Refresh live instance buffers from the current lattice + ages. */
  function refreshLiveLayer() {
    if (!geometryDirty) return;
    geometryDirty = false;

    if (liveSkinId !== activeSkin.id) {
      disposeLiveLayer();
      buildLiveLayer(activeSkin, maxCells);
    }

    const items = snapshotWithAges();

    // Growth guard: if the population exceeds the current allocation, rebuild bigger.
    if (liveMesh && items.length > meshCapacity(liveMesh)) {
      disposeLiveLayer();
      buildLiveLayer(activeSkin, Math.max(maxCells, items.length));
    }

    if (!liveMesh) return; // defensive: no layer built (empty lattice before boot)
    liveMesh.count = items.length;
    PALETTE_END.set(activeSkin.palette.old);
    for (let i = 0; i < items.length; i++) {
      const [x, y, z, ticks] = items[i];
      const t = ageNormalized(ticks);
      if (activeSkin.style === "wireframe") {
        CELL_COLOR.set(ticks <= 0 ? activeSkin.palette.young : t >= 0.6 ? activeSkin.palette.old : activeSkin.palette.mid);
      } else {
        CELL_COLOR.set(activeSkin.palette.young).lerp(PALETTE_END, t);
      }
      liveMesh.setColorAt(i, CELL_COLOR);
      writeInstanceMatrix(liveMesh, i, x, y, z);
    }
    liveMesh.instanceMatrix.needsUpdate = true;
    if (liveMesh.instanceColor) liveMesh.instanceColor.needsUpdate = true;

    if (liveGlow) {
      const position = liveGlow.geometry.attributes.position;
      for (let i = 0; i < items.length; i++) {
        position.setXYZ(i, items[i][0], items[i][1], items[i][2]);
      }
      position.needsUpdate = true;
      liveGlow.geometry.setDrawRange(0, items.length);
    }
  }

  // ---- Dying "ghost" fade layer ---------------------------------------------------
  const ghostLayer = new THREE.Group();
  scene.add(ghostLayer);

  let ghost = null; // { mesh, items: [{x,y,z,born}] }

  function disposeGhostLayer() {
    if (!ghost) return;
    ghostLayer.remove(ghost.mesh);
    ghost.mesh.geometry.dispose();
    ghost.mesh.material.dispose();
    ghost = null;
  }

  function buildGhostLayer(skinDef, capacityArg) {
    disposeGhostLayer();
    const capacity = Math.max(capacityArg ?? INSTANCE_CHUNK, INSTANCE_CHUNK);
    const geometry =
      skinDef.style === "organic"
        ? new THREE.SphereGeometry(skinDef.cell.size * 0.3, 6, 4)
        : new THREE.BoxGeometry(skinDef.cell.size * 0.62, skinDef.cell.size * 0.62, skinDef.cell.size * 0.62);
    const material =
      skinDef.style === "wireframe"
        ? new THREE.MeshBasicMaterial({
            color: new THREE.Color(skinDef.palette.dying),
            wireframe: true,
            transparent: true,
            opacity: 0.9,
          })
        : new THREE.MeshStandardMaterial({
            color: new THREE.Color(skinDef.palette.dying),
            emissive: new THREE.Color(skinDef.palette.dying),
            emissiveIntensity: 0.3,
            transparent: true,
            opacity: 0.85,
            roughness: 0.75,
          });
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    ghostLayer.add(mesh);
    ghost = { mesh, items: [] };
  }

  function spawnGhosts(coords) {
    if (!ghost || coords.length === 0) return;
    const now = performance.now();
    for (const coord of coords) {
      ghost.items.push({ x: coord[0], y: coord[1], z: coord[2], born: now });
    }
    const cutoff = now - DYING_FADE_MS - 2000;
    ghost.items = ghost.items.filter((item) => item.born > cutoff);
  }

  /** Advance ghost fades: dim color + shrink scale, remove finished entries. */
  function updateGhosts(now) {
    if (!ghost) return;
    const kept = ghost.items.filter((item) => now - item.born < DYING_FADE_MS);
    ghost.items = kept;
    if (kept.length === 0) {
      ghost.mesh.count = 0;
      return;
    }
    if (kept.length > meshCapacity(ghost.mesh)) {
      buildGhostLayer(activeSkin, kept.length);
      ghost.items = kept; // rebuild resets the item list; keep the live entries
    }
    ghost.mesh.count = kept.length;
    DYING_COLOR.set(activeSkin.palette.dying);
    for (let i = 0; i < kept.length; i++) {
      const item = kept[i];
      const progress = (now - item.born) / DYING_FADE_MS;
      const shade = 1 - progress;
      CELL_COLOR.copy(DYING_COLOR).multiplyScalar(shade);
      ghost.mesh.setColorAt(i, CELL_COLOR);
      writeInstanceMatrix(ghost.mesh, i, item.x, item.y, item.z, shade, shade, shade);
    }
    ghost.mesh.instanceMatrix.needsUpdate = true;
    if (ghost.mesh.instanceColor) ghost.mesh.instanceColor.needsUpdate = true;
  }

  // ---- Skin switching ---------------------------------------------------------------
  let activeSkin = getSkin(initialSkinId) ?? getSkin(DEFAULT_SKIN_ID);
  if (!activeSkin) activeSkin = getSkins()[0] ?? null;
  if (!activeSkin) throw new Error("no skins registered in src/skins/skins.js");

  /** Apply a skin by id (or definition): environment + cells rebuild; sim untouched. */
  function applySkin(skinIdOrDef) {
    const skinDef = typeof skinIdOrDef === "string" ? getSkin(skinIdOrDef) : skinIdOrDef;
    if (!skinDef) return false;
    activeSkin = skinDef;

    // Background gradient.
    const oldBg = scene.background;
    if (oldBg instanceof THREE.Texture) oldBg.dispose();
    scene.background = makeBackgroundTexture(skinDef.background, skinDef.backgroundTop);

    // Fog.
    if (skinDef.fog) {
      if (!(scene.fog instanceof THREE.Fog)) {
        scene.fog = new THREE.Fog(skinDef.fog.color, skinDef.fog.near, skinDef.fog.far);
      } else {
        scene.fog.color.set(skinDef.fog.color);
        scene.fog.near = skinDef.fog.near;
        scene.fog.far = skinDef.fog.far;
      }
    } else {
      scene.fog = null;
    }

    // Grid floor + axes.
    restyleGrid(grid, skinDef.grid.color1, skinDef.grid.color2, divisions);
    axes.setColors(skinDef.grid.axes, skinDef.grid.axes, skinDef.grid.axes);

    // Lights.
    ambient.color.set(skinDef.lights.ambient.color);
    ambient.intensity = skinDef.lights.ambient.intensity;
    keyLight.color.set(skinDef.lights.key.color);
    keyLight.intensity = skinDef.lights.key.intensity;
    const keyPos = skinDef.lights.key.position;
    keyLight.position.set(keyPos[0] ?? 20, keyPos[1] ?? 30, keyPos[2] ?? 15);
    fillLight.color.set(skinDef.lights.fill.color);
    fillLight.intensity = skinDef.lights.fill.intensity;
    const fillPos = skinDef.lights.fill.position;
    fillLight.position.set(fillPos[0] ?? -15, fillPos[1] ?? -10, fillPos[2] ?? -20);

    // Cell visuals.
    disposeLiveLayer();
    buildLiveLayer(skinDef, maxCells);
    buildGhostLayer(skinDef);
    geometryDirty = true;

    return true;
  }

  // ---- Main loop ---------------------------------------------------------------------
  let lastFrame = performance.now();

  /** Render one frame; call every animation tick. */
  function render() {
    const now = performance.now();
    lastFrame = now;

    if (geometryDirty) refreshLiveLayer();
    updateGhosts(now);

    // Additive glow pulse for bloom skins.
    if (liveGlow) {
      liveGlow.material.opacity = 0.22 * (0.85 + 0.15 * wave(now / 1000, 2.4));
    }

    controls.update();
    renderer.render(scene, camera);
  }

  function onResize() {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }

  window.addEventListener("resize", onResize);

  // ---- Remote presence markers (multiplayer cursor/label layer) --------------
  const presenceGroup = new THREE.Group();
  scene.add(presenceGroup);

  /** Map of peerId -> { mesh, name, color } rendered markers. */
  const presenceMarkers = new Map();

  /** Draw a rounded-rectangle path for the name label background. */
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Build the marker + floating name label for one remote peer.
   * @param {string} peerId
   * @param {string} name
   * @param {string} color Hex color string.
   */
  function addPresenceMarker(peerId, name, color) {
    if (presenceMarkers.has(peerId)) {
      presenceMarkers.get(peerId).name = name;
      return;
    }
    PEER_COLOR.set(color || "#39ff14");
    const material = new THREE.MeshBasicMaterial({ color: PEER_COLOR.getHex() });
    const mesh = new THREE.Mesh(PEER_MARKER_GEOMETRY, material);
    mesh.rotation.x = Math.PI / 2; // cone points up (+Y)
    mesh.raycast = () => {};
    mesh.position.set(0, 7, 0); // float above the lattice until first update
    presenceGroup.add(mesh);

    // Floating name label.
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.font = "bold 30px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(8,12,24,0.72)";
    roundRectPath(ctx, 16, 4, 224, 56, 14);
    ctx.fill();
    ctx.fillStyle = color || "#39ff14";
    ctx.fillText(name, 128, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture,
      depthWrite: false,
      transparent: true,
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(2.6, 0.65, 1);
    sprite.position.set(0, 1.2, 0);
    mesh.add(sprite);

    presenceMarkers.set(peerId, { mesh, name, color });
  }

  /** Update a remote peer's marker to a lattice cell (world-space position). */
  function updatePresenceMarker(peerId, x, y, z) {
    const entry = presenceMarkers.get(peerId);
    if (!entry) return;
    entry.mesh.position.set(x, y + 1.6, z);
    entry.mesh.visible = true;
  }

  /** Remove a remote peer's marker. */
  function removePresenceMarker(peerId) {
    const entry = presenceMarkers.get(peerId);
    if (!entry) return;
    presenceGroup.remove(entry.mesh);
    // NOTE: PEER_MARKER_GEOMETRY is a shared geometry; do NOT dispose it here
    // (other markers still use it). Dispose per-marker material + label only.
    entry.mesh.material.dispose();
    for (const child of [...entry.mesh.children]) {
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
      entry.mesh.remove(child);
    }
    presenceMarkers.delete(peerId);
  }

  /** Replace the whole presence layer (e.g. after roster refresh). */
  function setPresence(peers) {
    const seen = new Set();
    for (const peer of peers) {
      if (!peer || peer.peerId === peer.me) continue;
      seen.add(peer.peerId);
      addPresenceMarker(peer.peerId, peer.name || peer.peerId, peer.color);
    }
    for (const key of [...presenceMarkers.keys()]) {
      if (!seen.has(key)) removePresenceMarker(key);
    }
  }

  /** Clear every presence marker (session end). */
  function clearPresence() {
    for (const key of [...presenceMarkers.keys()]) removePresenceMarker(key);
  }

  /** Rebuild the live layer from the simulation's current cells (keeps ages). */
  function syncVoxels() {
    const snapshot = simulation.toSnapshot();
    const newKeys = new Set();
    for (const cell of snapshot.cells) {
      const key = `${cell[0]},${cell[1]},${cell[2]}`;
      newKeys.add(key);
      if (cellAges.has(key)) {
        cellAges.set(key, cellAges.get(key) + 1);
      } else {
        cellAges.set(key, 0);
      }
    }
    // Detect freshly dead cells for the cosmetic ghost fade and forget their age.
    if (lastLiveKeys) {
      const dead = [];
      for (const key of lastLiveKeys) {
        if (!newKeys.has(key)) {
          cellAges.delete(key);
          const [x, y, z] = key.split(",").map(Number);
          dead.push([x, y, z]);
        }
      }
      spawnGhosts(dead);
    }
    lastLiveKeys = newKeys;
    geometryDirty = true;
  }

  /** Tear down the scene (used by HMR / tests). */
  function dispose() {
    window.removeEventListener("resize", onResize);
    clearPresence();
    controls.dispose();
    disposeLiveLayer();
    disposeGhostLayer();
    if (scene.background instanceof THREE.Texture) scene.background.dispose();
    grid.geometry.dispose();
    grid.material.dispose();
    axes.geometry.dispose();
    axes.material.dispose();
    bgSphere.geometry.dispose();
    bgSphere.material.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode === container) {
      container.removeChild(renderer.domElement);
    }
  }

  // Boot the chosen skin visual layer, then draw the initial lattice.
  if (!applySkin(initialSkinId)) {
    applySkin(DEFAULT_SKIN_ID);
  }
  syncVoxels();

  return {
    renderer,
    scene,
    camera,
    controls,
    render,
    syncVoxels,
    applySkin,
    onResize,
    dispose,
    setPresence,
    updatePresenceMarker,
    removePresenceMarker,
    clearPresence,
    get activeSkinId() {
      return activeSkin ? activeSkin.id : null;
    },
  };
}