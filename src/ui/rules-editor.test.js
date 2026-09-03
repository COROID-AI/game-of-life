import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCustomRules, saveCustomRules, MAX_SAVED } from "./rules-editor.js";

/** Minimal in-memory localStorage stand-in (same getItem/setItem contract). */
function fakeStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
  };
}

const sample = {
  id: "custom-abc123",
  name: "My 3D Rule",
  mode: "life-like",
  birth: [2, 5],
  survive: [4],
};

test("custom rules persist through save/load via localStorage (reload scenario)", () => {
  const storage = fakeStorage();
  saveCustomRules([sample], storage);

  // A fresh editor (page reload) reads the same saved rules back.
  const reloaded = loadCustomRules(storage);
  assert.equal(reloaded.length, 1);
  assert.deepEqual(reloaded[0], sample);
  assert.equal(reloaded[0].id, "custom-abc123");
});

test("custom rules survive reload after an update and cap at MAX_SAVED", () => {
  const storage = fakeStorage();
  saveCustomRules([sample, { ...sample, id: "custom-2", name: "Second", birth: [0] }], storage);

  const reloaded = loadCustomRules(storage);
  assert.equal(reloaded.length, 2);

  // Re-save after deletion: only survivors remain after a fresh load.
  saveCustomRules(reloaded.filter((r) => r.id !== "custom-abc123"), storage);
  const afterDelete = loadCustomRules(storage);
  assert.equal(afterDelete.length, 1);
  assert.equal(afterDelete[0].id, "custom-2");

  // Cap enforcement keeps the persisted list bounded.
  const many = Array.from({ length: MAX_SAVED + 5 }, (_, i) => ({
    ...sample,
    id: `custom-${i}`,
    name: `Rule ${i}`,
  }));
  saveCustomRules(many, storage);
  assert.equal(loadCustomRules(storage).length, MAX_SAVED);
});

test("corrupt localSorage data degrades to an empty list instead of throwing", () => {
  const storage = {
    getItem() {
      return "{not valid json!!";
    },
    setItem() {},
  };
  assert.deepEqual(loadCustomRules(storage), []);

  const badShape = {
    getItem() {
      return JSON.stringify({ nope: true });
    },
    setItem() {},
  };
  assert.deepEqual(loadCustomRules(badShape), []);
});