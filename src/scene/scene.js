/**
 * three.js scene renderer for the Game of Life lattice.
 *
 * Renders the shared simulation state as a placeholder voxel lattice:
 *   - PerspectiveCamera + OrbitControls (drag to orbit, wheel to zoom)
 *   - Ambient + directional lighting with a dark background
 *   - A grid plane and a box for every live cell
 *
 * The module knows nothing about rules/multiplayer — it consumes the
 * simulation handle exposed by the core engine and rebuilds the voxel group
 * from `simulation.toSnapshot()` on demand.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { DEFAULT_SKIN } from "../contracts/index.js";

const CELL_SIZE = 0.8; // box edge (1.0 spacing leaves a visible gap)

/**
 * Create and attach a 3D scene to a container element.
 * @param {HTMLElement} container Element that hosts the renderer canvas.
 * @param {Object} options `{ simulation, skin? }`
 * @returns {Object} `{ renderer, scene, camera, controls, render, dispose }`
 */
export function createScene(container, options) {
  const simulation = options.simulation;
  const skin = options.skin ?? DEFAULT_SKIN;

  if (!simulation || typeof simulation.getCell !== "function") {
    throw new TypeError("createScene requires a simulation handle with getCell()");
  }
  if (!container || typeof container.appendChild !== "function") {
    throw new TypeError("createScene requires a DOM container element");
  }

  const size = simulation.size;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(new THREE.Color(skin.background));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(skin.background);

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

  // Lighting: a soft ambient + key directional so voxels read as solid 3D.
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
  keyLight.position.set(20, 30, 15);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8899ff, 0.35);
  fillLight.position.set(-15, -10, -20);
  scene.add(fillLight);

  // Reference floor so the lattice is readable from any camera angle.
  const grid = new THREE.GridHelper(size, size, 0x334466, 0x1c2740);
  grid.position.y = -size / 2 - 1;
  scene.add(grid);
  const axes = new THREE.AxesHelper(size / 2);
  axes.position.set(0, -size / 2 - 1, 0);
  scene.add(axes);

  const voxelGroup = new THREE.Group();
  scene.add(voxelGroup);

  const geometry = new THREE.BoxGeometry(CELL_SIZE, CELL_SIZE, CELL_SIZE);
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(skin.color),
    emissive: new THREE.Color(skin.emissive),
    roughness: 0.45,
    metalness: 0.05,
  });

  /** Rebuild the voxel group from the simulation's live cells. */
  function syncVoxels() {
    voxelGroup.clear();
    const snapshot = simulation.toSnapshot();
    for (const [x, y, z] of snapshot.cells) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      voxelGroup.add(mesh);
    }
  }

  syncVoxels();

  /** Render one frame; call every animation tick. */
  function render() {
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

  /** Tear down the scene (used by HMR / tests). */
  function dispose() {
    window.removeEventListener("resize", onResize);
    controls.dispose();
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode === container) {
      container.removeChild(renderer.domElement);
    }
  }

  return {
    renderer,
    scene,
    camera,
    controls,
    render,
    syncVoxels,
    onResize,
    dispose,
  };
}