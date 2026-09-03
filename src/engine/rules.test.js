import { test } from "node:test";
import assert from "node:assert/strict";

import { createSimulation } from "./simulation.js";
import {
  NEIGHBOR_MAX,
  NEIGHBORHOOD_3D,
  PRESET_RULE_SETS,
  SHARE_PREFIX,
  isValidNeighborCount,
  normalizeCounts,
  toRuleString,
  parseRuleString,
  createRuleFromCounts,
  sameRule,
  getPreset,
  encodeRuleShare,
  decodeRuleShare,
} from "./rules.js";
import { validateRuleSet } from "../contracts/ruleSet.js";
import { BLOCK, setPattern } from "./patterns.js";

test("rules: the 3D Moore neighbourhood is exactly the 26 neighbours (not 8)", () => {
  assert.equal(NEIGHBORHOOD_3D.length, 26);
  assert.equal(NEIGHBOR_MAX, 26);

  // Every delta in the 3×3×3 box except (0,0,0), unique, in [-1,1]³.
  const seen = new Set();
  for (const [dx, dy, dz] of NEIGHBORHOOD_3D) {
    assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && Math.abs(dz) <= 1, "delta inside the 3-cube");
    assert.ok(!(dx === 0 && dy === 0 && dz === 0), "no self-neighbour");
    seen.add(`${dx},${dy},${dz}`);
  }
  assert.equal(seen.size, 26);
});

test("rules: presets follow B/S notation, validate, and are individually selectable", () => {
  assert.equal(PRESET_RULE_SETS.length, 5);
  const expected = [
    ["conway-b3s23", "B3/S23"],
    ["highlife", "B36/S23"],
    ["seeds", "B2/S"],
    ["day-night", "B3678/S34678"],
    ["bays-3d", "B25/S45"],
  ];
  for (let i = 0; i < PRESET_RULE_SETS.length; i++) {
    const rule = PRESET_RULE_SETS[i];
    validateRuleSet(rule); // must not throw
    assert.equal(toRuleString(rule), expected[i][1], `${rule.id} serializes to ${expected[i][1]}`);
    assert.equal(getPreset(rule.id), rule);
    assert.equal(getPreset("missing"), undefined);
  }
  assert.ok(PRESET_RULE_SETS[4].id === "bays-3d", "the fifth preset is the 3D-flavoured rule");
});

test("rules: B/S notation round-trips including extended 3D counts A..Q", () => {
  assert.deepEqual(parseRuleString("B3/S23"), { birth: [3], survive: [2, 3] });
  assert.deepEqual(parseRuleString("b36/s23"), { birth: [3, 6], survive: [2, 3] });
  assert.deepEqual(parseRuleString("B2/S"), { birth: [2], survive: [] });
  assert.deepEqual(parseRuleString("B3678/S34678"), { birth: [3, 6, 7, 8], survive: [3, 4, 6, 7, 8] });
  assert.deepEqual(toRuleString({ birth: [3], survive: [2, 3] }), "B3/S23");
  assert.deepEqual(toRuleString({ birth: [2], survive: [] }), "B2/S");
  // 3D counts up to 26: A=10 .. Q=26.
  assert.deepEqual(parseRuleString("BAQ/S13"), { birth: [10, 26], survive: [1, 3] });
  assert.deepEqual(toRuleString({ birth: [10, 26], survive: [1, 3] }), "BAQ/S13");
  assert.deepEqual(toRuleString({ birth: [26], survive: [] }), "BQ/S");
  assert.deepEqual(toRuleString({ birth: [0, 0, 2, 1], survive: [3, 2] }), "B012/S23"); // dedupe + sort

  assert.throws(() => parseRuleString("S3"), /invalid rule string/);
  assert.throws(() => parseRuleString("B3X/S23"), /invalid rule string/);
  assert.throws(() => parseRuleString(""), /invalid rule string/);
  assert.throws(() => parseRuleString(42), /string/);
});

test("rules: neighbour-count helpers enforce the 0..26 range", () => {
  assert.equal(isValidNeighborCount(0), true);
  assert.equal(isValidNeighborCount(26), true);
  assert.equal(isValidNeighborCount(27), false);
  assert.equal(isValidNeighborCount(-1), false);
  assert.equal(isValidNeighborCount(3.5), false);
  assert.deepEqual(normalizeCounts([3, 1, 3, 99, -2, 26, 0]), [0, 1, 3, 26]);
  assert.deepEqual(normalizeCounts(undefined), []);
});

test("rules: createRuleFromCounts produces a validated frozen rule-set", () => {
  const rule = createRuleFromCounts({ name: "Mine", birth: [3, 6], survive: [2, 3] });
  validateRuleSet(rule);
  assert.equal(rule.mode, "life-like");
  assert.equal(sameRule(rule, { birth: [6, 3], survive: [2, 3], id: "x", name: "y" }), true);
  assert.equal(sameRule(rule, { birth: [6], survive: [2, 3] }), false);
});

test("rules: swapping rule-sets changes evolution at runtime (deterministic)", () => {
  const make = () => {
    const sim = createSimulation({ size: 12, seedDensity: 0 });
    // Clean L-corner in the z=0 plane: (0,0,0), (1,0,0), (0,1,0).
    sim.setCell(0, 0, 0, 1);
    sim.setCell(1, 0, 0, 1);
    sim.setCell(0, 1, 0, 1);
    return sim;
  };

  // B3/S23 (Conway): (1,1,0) is born with 3 neighbours; centre cell survives
  // with 2. In the full 26-neighbour 3D set the corner also births off-plane
  // cells (e.g. (0,0,1) has 3 neighbours), so the population grows past 3.
  const conway = make();
  conway.tick(getPreset("conway-b3s23"));
  assert.equal(conway.getCell(1, 1, 0), 1);
  assert.equal(conway.getCell(0, 0, 0), 1);
  assert.ok(conway.population > 3, "3D B3/S23 births off-plane cells");

  // B2/S (Seeds): with survival counts empty, the original live cells die while
  // new cells are born on every 2-neighbour site.
  const seeds = make();
  seeds.tick(getPreset("seeds"));
  assert.equal(seeds.getCell(0, 0, 0), 0);
  assert.ok(seeds.population > 0);

  // HighLife B36/S23 adds birth-on-6. A dead centre surrounded by exactly the
  // six face-neighbours is born under B36/S23 but not under Conway B3/S23.
  const ring = () => {
    const sim = createSimulation({ size: 12, seedDensity: 0 });
    const face = [[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]];
    for (const [dx, dy, dz] of face) sim.setCell(dx, dy, dz, 1);
    return sim;
  };
  const ringConway = ring();
  ringConway.tick(getPreset("conway-b3s23"));
  const ringHigh = ring();
  ringHigh.tick(getPreset("highlife"));
  assert.equal(ringConway.getCell(0, 0, 0), 0, "Conway does not birth on 6 neighbours");
  assert.equal(ringHigh.getCell(0, 0, 0), 1, "HighLife births on 6 neighbours");

  // Determinism: same seed + same rule + same ticks = same world.
  const a = createSimulation({ size: 16, seedDensity: 0.2, seed: 42 });
  const b = createSimulation({ size: 16, seedDensity: 0.2, seed: 42 });
  for (let i = 0; i < 5; i++) {
    a.tick(getPreset("day-night"));
    b.tick(getPreset("day-night"));
  }
  assert.deepEqual(a.toSnapshot(), b.toSnapshot());
});

test("rules: share code round-trips a whole named rule-set", () => {
  const rule = createRuleFromCounts({ name: "My 3D Rule", birth: [2, 5, 26], survive: [4, 5] });
  const code = encodeRuleShare(rule);
  assert.ok(code.startsWith(SHARE_PREFIX), "share code carries the life3d prefix");
  assert.ok(code.length < 120, "share code stays compact");

  const imported = decodeRuleShare(code);
  validateRuleSet(imported);
  assert.equal(imported.name, "My 3D Rule");
  assert.equal(imported.mode, "life-like");
  assert.deepEqual(toRuleString(imported), "B25Q/S45");

  // Prefix and bare base64 forms both decode.
  assert.deepEqual(toRuleString(decodeRuleShare(code.slice(SHARE_PREFIX.length))), "B25Q/S45");
  // Plain B/S notation is accepted as a share code too.
  const fromNotation = decodeRuleShare("B36/S23");
  assert.equal(toRuleString(fromNotation), "B36/S23");

  assert.throws(() => decodeRuleShare("not-a-code"), /could not decode/);
  assert.throws(() => decodeRuleShare(""), /empty share code/);
});