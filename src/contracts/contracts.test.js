import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RULE_SET_SCHEMA,
  DEFAULT_RULE_SET,
  createRuleSet,
  compactRuleSet,
  isRuleSet,
  validateRuleSet,
} from "./ruleSet.js";
import {
  WORLD_STATE_SCHEMA,
  isWorldState,
  validateWorldState,
} from "./worldState.js";
import { DEFAULT_SKIN, isSkin, validateSkin } from "./skin.js";
import { DEFAULTS, WORLD_VOLUME, MAX_GRID_SIZE, MAX_WORLD_CELLS } from "./simulation.js";

test("contracts: barrel exports the shared API surface", async () => {
  // The index barrel is what phase-2 tasks will import from.
  const mod = await import("./index.js");
  assert.equal(typeof mod.RULE_SET_SCHEMA, "object");
  assert.equal(typeof mod.DEFAULT_RULE_SET, "object");
  assert.equal(typeof mod.WORLD_STATE_SCHEMA, "object");
  assert.equal(typeof mod.DEFAULT_SKIN, "object");
  assert.equal(typeof mod.SIMULATION_DEFAULTS, "object");
  assert.equal(typeof mod.isRuleSet, "function");
  assert.equal(typeof mod.validateWorldState, "function");
});

test("ruleSet: schema declares the expected shape and default B3/S23 is valid", () => {
  assert.equal(RULE_SET_SCHEMA.type, "object");
  assert.deepEqual(RULE_SET_SCHEMA.required, ["id", "name", "mode"]);
  assert.ok(DEFAULT_RULE_SET.birth.includes(3));
  assert.ok(DEFAULT_RULE_SET.survive.includes(2));
  assert.ok(DEFAULT_RULE_SET.survive.includes(3));
  validateRuleSet(DEFAULT_RULE_SET); // must not throw
  assert.equal(isRuleSet(DEFAULT_RULE_SET), true);
});

test("ruleSet: validators accept a valid rule-set and reject invalid ones", () => {
  validateRuleSet(createRuleSet({ id: "r1", name: "R1", mode: "conway", birth: [3], survive: [2, 3] }));

  assert.throws(() => createRuleSet({ id: "", name: "X", mode: "conway" }), /id/);
  assert.throws(() => createRuleSet({ id: "r", name: "X", mode: "weird" }), /mode/);
  assert.throws(() => createRuleSet({ id: "r", name: "X", mode: "conway", birth: [99] }), /0\.\.26/);
  assert.throws(() => createRuleSet({ id: "r", name: "X", mode: "conway", survive: [-1] }), /0\.\.26/);
  // A minimal id/name/mode rule-set is valid (birth/survive default to B3/S23).
  assert.equal(isRuleSet({ id: "r", name: "X", mode: "conway" }), true);
  assert.equal(isRuleSet({ mode: "conway" }), false); // missing id/name
});

test("ruleSet: compactRuleSet produces the portable wire form", () => {
  const compact = compactRuleSet(DEFAULT_RULE_SET);
  assert.deepEqual(compact, {
    id: "conway-b3s23",
    name: "Conway B3/S23 (3D)",
    mode: "conway",
    birth: [3],
    survive: [2, 3],
    plane: null,
    planeOffset: 0,
  });
});

test("worldState: schema and validators accept compact world snapshots", () => {
  assert.equal(WORLD_STATE_SCHEMA.required.includes("cells"), true);
  validateWorldState({ generation: 0, size: 16, cells: [[0, 0, 0, 1], [1, 2, 3, 0]] });
  assert.equal(isWorldState({ generation: 0, size: 16, cells: [] }), true);
  assert.throws(() => validateWorldState({ generation: -1, size: 16, cells: [] }), /generation/);
  assert.throws(() => validateWorldState({ generation: 0, size: 0, cells: [] }), /size/);
  assert.throws(() => validateWorldState({ generation: 0, size: 16, cells: [[0, 0, 0, 2]] }), /alive/);
  assert.throws(() => validateWorldState({ generation: 0, size: 16, cells: [[0, 0]] }), /each cell entry/);
});

test("worldState: oversized snapshots are rejected (grid + cell caps)", () => {
  // size beyond MAX_GRID_SIZE must be rejected.
  assert.throws(
    () => validateWorldState({ generation: 0, size: MAX_GRID_SIZE + 1, cells: [] }),
    /exceeds the cap/,
  );
  // cell list beyond MAX_WORLD_CELLS must be rejected.
  const tooMany = [];
  for (let i = 0; i < MAX_WORLD_CELLS + 1; i++) {
    tooMany.push([i % MAX_GRID_SIZE, (i * 7) % MAX_GRID_SIZE, (i * 13) % MAX_GRID_SIZE, 1]);
  }
  assert.throws(() => validateWorldState({ generation: 0, size: MAX_GRID_SIZE, cells: tooMany }), /cell count|exceeds the cap/);
  // A lattice at the cap with an empty cell list is still valid.
  assert.equal(isWorldState({ generation: 0, size: MAX_GRID_SIZE, cells: [] }), true);
});

test("worldState: coordinates must stay inside the lattice bounds", () => {
  // size 16 -> half == 8 -> valid coords in [-8, 7].
  validateWorldState({ generation: 0, size: 16, cells: [[-8, 7, 0, 1], [0, 0, 0, 0]] });
  assert.throws(() => validateWorldState({ generation: 0, size: 16, cells: [[8, 0, 0, 1]] }), /coordinate 0/);
  assert.throws(() => validateWorldState({ generation: 0, size: 16, cells: [[0, -9, 0, 1]] }), /coordinate 1/);
  assert.throws(() => validateWorldState({ generation: 0, size: 16, cells: [[0, 0, 8, 1]] }), /coordinate 2/);
});

test("skin: default skin is valid and validator rejects malformed themes", () => {
  validateSkin(DEFAULT_SKIN);
  assert.equal(isSkin(DEFAULT_SKIN), true);
  assert.equal(isSkin({ id: "x" }), false);
  assert.throws(
    () => validateSkin({ id: "x", label: "Y", color: 7, emissive: "x", background: "y", description: "d" }),
    /color/,
  );
  assert.throws(
    () => validateSkin({ id: 1, label: "Y", color: "#fff", emissive: "x", background: "y", description: "d" }),
    /id/,
  );
});

test("simulation defaults: shared constants match the scaffold sizing", () => {
  assert.equal(DEFAULTS.SIZE, 16);
  assert.equal(DEFAULTS.SEED_DENSITY, 0.2);
  assert.equal(DEFAULTS.SPEED, 4);
  assert.equal(WORLD_VOLUME, 16 * 16 * 16);
});