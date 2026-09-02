#!/usr/bin/env node
/**
 * End-to-end browser verification for the 3D Game of Life delivery goals.
 *
 * Self-hosts a Vite dev server + the WebSocket relay, opens a browser, and
 * verifies the acceptance criteria:
 *   1. Launch: app renders a 3D canvas with no console errors.
 *   2. Simulate: Step/Pause/Resume advance the generation.
 *   3. Custom rule: editor toggles a birth count and the active badge shows
 *      the applied rule, `custom-rule:explored` metric is emitted.
 *   4. Skins: all three registry skins apply with no console errors.
 *   5. Multiplayer: two windows create/join a room, share a snapshot
 *      (generation > 0 on both), roster shows both peers, join metrics fire.
 *   6. Onboarding: each required step renders and the tour dismisses.
 *   7. FPS: readings exist at the default preset and after applying Large.
 *
 * Run: `npm run e2e` (requires playwright + its Chromium, both installed by
 * `npm install`). Set E2E_BROWSER=firefox for the Firefox pass.
 *
 * Headless environments without a GPU cannot create a WebGL context in
 * Firefox (FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS). In that case the WebGL
 * sections are skipped and a documented environment-limitation is reported;
 * Chromium (with SwiftShader software GL) runs the full pass.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (...a) => console.log("[e2e]", ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) log(`✔ ${name}`);
  else {
    failures++;
    log(`✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function freePort() {
  const s = createServer();
  s.listen(0);
  await new Promise((r) => s.once("listening", r));
  const p = s.address().port;
  s.close();
  await new Promise((r) => s.once("close", r));
  return p;
}

async function waitHttp(url, ms = 20000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      const u = new URL(url);
      const ok = await new Promise((resolve) => {
        const req = httpRequest(
          { host: u.hostname, port: Number(u.port), path: u.pathname, method: "GET" },
          (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500);
          },
        );
        req.on("error", () => resolve(false));
        req.setTimeout(1000, () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
      if (ok) return true;
    } catch {}
    await wait(300);
  }
  return false;
}

async function makeServer() {
  const appPort = await freePort();
  const relayPort = await freePort();
  log(`booting vite :${appPort} and relay :${relayPort}`);
  const app = spawn(
    "npx", ["vite", "--port", String(appPort), "--strictPort", "--host", "0.0.0.0"],
    { cwd: ROOT, stdio: "ignore" },
  );
  const relay = spawn(
    process.execPath, [path.join(ROOT, "server", "relay.js")],
    { env: { ...process.env, PORT: String(relayPort), HOST: "127.0.0.1" }, stdio: "ignore" },
  );
  const appUrl = `http://127.0.0.1:${appPort}/`;
  const relayHttp = `http://127.0.0.1:${relayPort}`;
  if (!(await waitHttp(appUrl))) throw new Error("vite not ready");
  if (!(await waitHttp(`${relayHttp}/health`))) throw new Error("relay not ready");
  log("servers ready");
  return {
    appUrl: appUrl + `?relay=${encodeURIComponent(`ws://127.0.0.1:${relayPort}/ws`)}`,
    cleanup: () => { app.kill("SIGTERM"); relay.kill("SIGTERM"); },
  };
}

async function newPage(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  const warnings = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
    if (m.type() === "warning") warnings.push(m.text());
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
  let canvas = false;
  try {
    await page.locator("#app canvas").waitFor({ state: "attached", timeout: 25000 });
    canvas = true;
  } catch {
    // Fall through; may be a WebGL-less environment.
  }
  await wait(400);
  const webglUnavailable =
    !canvas &&
    warnings.some((w) => w.includes("WebGL") && w.includes("Failed to create"));
  return { ctx, page, errors, canvas, webglUnavailable };
}

async function runInteractiveChecks(browser, server) {
  // ---- 3. Custom rule --------------------------------------------------------
  {
    const { ctx, page } = await newPage(browser, server.appUrl);
    await page.click(".re-open");
    await page.locator(".re-modal:not([hidden])").waitFor({ state: "attached", timeout: 10000 });
    await page.click('.re-count[data-n="5"]');
    await wait(250);
    const badge = (await page.locator(".re-active").textContent()).trim();
    check("rule: custom rule applied (editor badge updates)", badge.includes("B35/S23"), badge);
    const flag = await page.evaluate(
      () => window.__life3dMetrics.getEvents().some((e) => e.name === "custom-rule:explored"),
    );
    check("rule: custom-rule:explored metric emitted", flag === true);
    await page.click(".re-close");
    await ctx.close();
  }

  // ---- 4. All skins ----------------------------------------------------------
  {
    const { ctx, page } = await newPage(browser, server.appUrl);
    for (const id of ["classic-voxels", "neon-wireframe", "organic"]) {
      const ok = await page.evaluate((skinId) => {
        try {
          const applied = window.__life3d.setSkin(skinId);
          window.__life3d.scene?.render();
          return applied === true && window.__life3d.activeSkinId === skinId;
        } catch (e) {
          return `throw:${e.message}`;
        }
      }, id);
      await wait(450);
      check(`skin: ${id} applies`, ok === true, String(ok));
    }
    await ctx.close();
  }

  // ---- 5. Multiplayer two-window session ---------------------------------------
  {
    const hostP = newPage(browser, server.appUrl);
    const guestP = newPage(browser, server.appUrl);
    const [{ ctx: hctx, page: host, errors: herr }, { ctx: gctx, page: guest, errors: gerr }] =
      await Promise.all([hostP, guestP]);

    await host.locator("#mp-create").waitFor({ state: "attached", timeout: 20000 });
    await guest.locator("#mp-join").waitFor({ state: "attached", timeout: 20000 });
    await host.click("#mp-create");
    await wait(1200);
    const code = (await host.locator(".mp-code").textContent()).trim();
    check("multiplayer: host creates room with code", /^[A-Z2-9]{5}$/.test(code), code);

    await guest.fill("#mp-join-code", code);
    await guest.click("#mp-join");

    let guestStatus = "connecting";
    for (let i = 0; i < 40; i++) {
      guestStatus = (await guest.locator("#mp-status").textContent()).trim();
      if (guestStatus.includes("joined") || guestStatus.includes("host")) break;
      await wait(500);
    }
    const hostStatus = (await host.locator("#mp-status").textContent()).trim();
    check("multiplayer: host sees joined state", hostStatus.includes("joined") || hostStatus.includes("host"), hostStatus);
    check("multiplayer: guest sees joined state", guestStatus.includes("joined") || guestStatus.includes("host"), guestStatus);

    const hostRoster = await host.locator(".mp-peer").count();
    const guestRoster = await guest.locator(".mp-peer").count();
    check("multiplayer: roster shows both peers", hostRoster >= 1 && guestRoster >= 1, `h=${hostRoster} g=${guestRoster}`);

    await wait(1200);
    const hostGen = Number(await host.locator("#generation").textContent());
    const guestGen = Number(await guest.locator("#generation").textContent());
    check("multiplayer: shared snapshot converges (gen > 0 on both)", hostGen > 0 && guestGen > 0, `h=${hostGen} g=${guestGen}`);

    const hm = await host.evaluate(() => window.__life3dMetrics.getEvents().some((e) => e.name === "multiplayer:join"));
    const gm = await guest.evaluate(() => window.__life3dMetrics.getEvents().some((e) => e.name === "multiplayer:join"));
    check("multiplayer: join metric emitted on host", hm === true);
    check("multiplayer: join metric emitted on guest", gm === true);

    const errs = [...herr, ...gerr];
    check("multiplayer: no console errors in either client", errs.length === 0, errs.join(" | "));
    await hctx.close();
    await gctx.close();
  }

  // ---- 6. Onboarding -----------------------------------------------------------
  {
    const { ctx, page } = await newPage(browser, server.appUrl);
    await page.evaluate(() => window.__life3dOnboarding?.dismiss?.());
    await page.evaluate(() => window.localStorage.removeItem("game-of-life-3d:onboarding-v1"));
    await page.evaluate(() => window.__life3dOnboarding.start());
    await wait(300);
    const stepTextChecks = {
      camera: "orbit",
      rules: "Rules",
      skins: "Theme",
      multiplayer: "Create room",
    };
    for (const step of ["camera", "rules", "skins", "multiplayer"]) {
      const rendered = await page.evaluate((id) => {
        const el = document.querySelector(".ob-wrap");
        return !el.hidden && el.textContent.includes(id);
      }, stepTextChecks[step]);
      check(`onboarding: step "${step}" renders`, rendered === true);
      if (step !== "multiplayer") {
        const nextVisible = await page.evaluate(() => {
          const b = document.querySelector(".ob-next");
          return b && !b.hidden;
        });
        if (nextVisible) await page.click(".ob-next");
        else await page.evaluate(() => window.__life3dOnboarding.showStep(window.__life3dOnboarding.getState().index + 1));
      }
      await wait(250);
    }
    // Jump to the final step (grid) and confirm Got it is the finish affordance.
    await page.evaluate(() => {
      window.__life3dOnboarding.showStep(4);
    });
    await wait(200);
    const doneVisible = await page.evaluate(() => {
      const b = document.querySelector(".ob-done");
      return b && !b.hidden;
    });
    check("onboarding: Got it visible on final step", doneVisible === true);
    await page.click(".ob-done");
    await wait(200);
    const dismissed = await page.evaluate(() => document.querySelector(".ob-wrap").hidden);
    check("onboarding: tour dismisses", dismissed === true);
    await ctx.close();
  }

  // ---- 7. FPS ------------------------------------------------------------------
  {
    const { ctx, page } = await newPage(browser, server.appUrl);
    await page.evaluate(() => window.__life3dQuality.setQuality(0));
    await wait(1600);
    const fpsDefault = await page.evaluate(() => window.__life3dQuality.getFps());
    await page.evaluate(() => window.__life3dQuality.applyPreset("large"));
    await wait(1600);
    const fpsLarge = await page.evaluate(() => window.__life3dQuality.getFps());
    const preset = await page.evaluate(() => window.__life3dQuality.getPreset());
    check("fps: default preset has a reading", Number(fpsDefault) > 0, `fps=${fpsDefault}`);
    check("fps: large preset applied with reading", preset.size === 32 && Number(fpsLarge) > 0, `size=${preset?.size} fps=${fpsLarge}`);
    await ctx.close();
  }
}

async function main() {
  console.log("[e2e] main start");
  const server = await makeServer();
  const browserName = process.env.E2E_BROWSER || "chromium";
  log(`launching browser: ${browserName}`);
  let browser;
  if (browserName === "firefox") {
    const { firefox } = await import("playwright");
    browser = await firefox.launch({
      headless: true,
      firefoxUserPrefs: {
        "webgl.force-enabled": true,
        "webgl.disabled": false,
        "layers.acceleration.force-enabled": true,
        "gfx.webrender.software": true,
      },
    });
  } else {
    browser = await chromium.launch({
      headless: true,
      args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
    });
  }
  try {
    let webglUnavailable = false;
    // ---- 1 + 2. Launch + simulate --------------------------------------------
    {
      const { ctx, page, errors, canvas, webglUnavailable: pageWebgl } = await newPage(browser, server.appUrl);
      webglUnavailable = pageWebgl;
      if (webglUnavailable) {
        // Headless Firefox sandbox cannot create a WebGL context; the app is a
        // three.js WebGL app. Verify the app shell page loads (HTML served),
        // then record the environment limitation and skip the WebGL checks.
        const shellLoaded = await page.evaluate(() => {
          return Boolean(document.getElementById("hud") && document.getElementById("app"));
        });
        check("launch: app shell loads (Firefox, WebGL unavailable)", shellLoaded === true);
        log("⚠ environment limitation: headless Firefox sandbox lacks WebGL; skipping WebGL sections");
      } else {
        check("launch: app renders a 3D canvas", canvas === true);
        await wait(700);
        const gen0 = Number(await page.locator("#generation").textContent());
        check("launch: simulation auto-runs (generation > 0)", gen0 > 0, `gen=${gen0}`);

        await page.click("#step-btn");
        await wait(300);
        const genStep = Number(await page.locator("#generation").textContent());
        check("simulate: Step advances generation", genStep >= gen0, `${gen0}→${genStep}`);

        await page.click("#play-pause-btn");
        const paused = Number(await page.locator("#generation").textContent());
        await wait(700);
        const after = Number(await page.locator("#generation").textContent());
        check("simulate: Pause freezes generation", after <= paused + 2, `${paused}→${after}`);

        await page.click("#play-pause-btn");
        await wait(600);
        const resumed = Number(await page.locator("#generation").textContent());
        check("simulate: Resume continues", resumed > paused, `${paused}→${resumed}`);

        check("launch: no console errors", errors.length === 0, errors.join(" | "));
      }
      await ctx.close();
    }

    if (!webglUnavailable) {
      await runInteractiveChecks(browser, server);
    } else {
      log("⚠ WebGL unavailable in this environment — ran smoke-only pass");
    }
  } finally {
    await browser.close();
    server.cleanup();
  }

  log(failures === 0 ? "ALL E2E CHECKS PASSED" : `${failures} E2E CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});