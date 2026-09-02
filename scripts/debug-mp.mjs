// Temporary diagnostic harness (NOT part of the deliverable; removed after use).
// Boots vite + relay, opens Chromium, and probes the multiplayer create/join
// click hang observed in `npm run e2e`.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let probeFailures = 0;
function checkProbe(name, ok, detail) {
  console.log(`  ${ok ? "ok" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) probeFailures += 1;
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
        const req = http.get({ host: u.hostname, port: Number(u.port), path: u.pathname }, (res) => {
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(1000, () => {
          req.destroy();
          resolve(false);
        });
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
  console.log(`booting vite :${appPort} and relay :${relayPort}`);
  const app = spawn("npx", ["vite", "--port", String(appPort), "--strictPort", "--host", "0.0.0.0"], { cwd: ROOT, stdio: "ignore" });
  const relay = spawn(process.execPath, [path.join(ROOT, "server", "relay.js")], {
    env: { ...process.env, PORT: String(relayPort), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  const appUrl = `http://127.0.0.1:${appPort}/`;
  const relayHttp = `http://127.0.0.1:${relayPort}`;
  if (!(await waitHttp(appUrl))) throw new Error("vite not ready");
  if (!(await waitHttp(`${relayHttp}/health`))) throw new Error("relay not ready");
  return {
    appUrl: appUrl + `?relay=${encodeURIComponent(`ws://127.0.0.1:${relayPort}/ws`)}`,
    cleanup: () => {
      app.kill("SIGTERM");
      relay.kill("SIGTERM");
    },
  };
}

async function newPage(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
  try {
    await page.locator("#app canvas").waitFor({ state: "attached", timeout: 15000 });
  } catch {
    // Some probes run after multiple WebGL contexts were already created;
    // the canvas may not attach on SwiftShader. Continue with the DOM shell.
  }
  await wait(600);
  return { ctx, page, errors };
}

async function main() {
  const server = await makeServer();
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });

  try {
    // Probe 1: is the onboarding bubble occluding #mp-create on a fresh page?
    {
      const { ctx, page, errors } = await newPage(browser, server.appUrl);
      const info = await page.evaluate(() => {
        const bubble = document.querySelector(".ob-wrap");
        const btn = document.querySelector("#mp-create");
        const b = bubble?.getBoundingClientRect();
        const r = btn?.getBoundingClientRect();
        const btop = bubble ? Number(getComputedStyle(bubble).zIndex) : null;
        const bpt = bubble ? getComputedStyle(bubble).pointerEvents : null;
        const elAtCenter = btn ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
        return {
          tourHidden: !!bubble?.hidden,
          tourZ: btop,
          tourPointer: bpt,
          btnRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
          bubbleRect: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null,
          elementAtBtnCenter: elAtCenter ? `${elAtCenter.tagName}.${elAtCenter.className}` : null,
          mpCreateVisible: !!btn && btn.offsetParent !== null,
        };
      });
      console.log("PROBE1 tour/mp state:", JSON.stringify(info, null, 2));
      console.log("PROBE1 page errors:", errors);
      await ctx.close();
    }

    // Probe 2: dismiss the tour, then click #mp-create and observe the result.
    {
      const { ctx, page, errors } = await newPage(browser, server.appUrl);
      await page.evaluate(() => {
        window.__life3dOnboarding?.dismiss?.();
        window.__life3dOnboarding?.destroy?.();
        document.querySelector(".ob-wrap")?.setAttribute("hidden", "");
      });
      await wait(200);
      const before = await page.evaluate(() => {
        const btn = document.querySelector("#mp-create");
        return {
          hidden: btn?.hidden,
          disabled: btn?.disabled,
          rect: btn?.getBoundingClientRect().toJSON(),
        };
      });
      console.log("PROBE2 before click:", JSON.stringify(before, null, 2));
      await page.click("#mp-create", { timeout: 15000 });
      await wait(1500);
      const after = await page.evaluate(() => ({
        code: document.querySelector(".mp-code")?.textContent?.trim(),
        status: document.querySelector("#mp-status")?.textContent?.trim(),
        roster: document.querySelectorAll(".mp-peer").length,
      }));
      console.log("PROBE2 after click:", JSON.stringify(after, null, 2));
      console.log("PROBE2 page errors:", errors);
      await ctx.close();
    }

    // Probe 3: two pages in parallel (host + guest), tour dismissed.
    // Uses synthetic .click() so we can discriminate an app-level defect from
    // a CDP trusted-input stall under dual SwiftShader WebGL contexts.
    {
      const hostP = newPage(browser, server.appUrl);
      const guestP = newPage(browser, server.appUrl);
      const [{ ctx: hctx, page: host, errors: herr }, { ctx: gctx, page: guest, errors: gerr }] =
        await Promise.all([hostP, guestP]);
      for (const p of [host, guest]) {
        await p.evaluate(() => {
          window.__life3dOnboarding?.dismiss?.();
          window.__life3dOnboarding?.destroy?.();
          document.querySelector(".ob-wrap")?.setAttribute("hidden", "");
        });
      }
      await wait(300);
      // Host: try a Playwright trusted click first; on timeout, fall back to
      // a synthetic DOM click so the probe can keep going either way.
      let trustedHostClick = "ok";
      try {
        await host.click("#mp-create", { timeout: 8000, force: false });
      } catch (e) {
        trustedHostClick = `timeout:${e.name}`;
        await host.evaluate(() => document.querySelector("#mp-create").click());
      }
      await wait(1200);
      const code = (await host.locator(".mp-code").textContent()).trim();
      const hostStatus = (await host.locator("#mp-status").textContent()).trim();
      console.log("PROBE3 trusted click:", trustedHostClick, "| host code:", code, "| status:", hostStatus);
      checkProbe("PROBE3 create works", /^[A-Z2-9]{5}$/.test(code) && hostStatus.includes("host"), `${code} / ${hostStatus}`);

      await guest.fill("#mp-join-code", code);
      let trustedGuestClick = "ok";
      try {
        await guest.click("#mp-join", { timeout: 8000, force: false });
      } catch (e) {
        trustedGuestClick = `timeout:${e.name}`;
        await guest.evaluate(() => document.querySelector("#mp-join").click());
      }
      let gs = "connecting";
      for (let i = 0; i < 40; i++) {
        gs = (await guest.locator("#mp-status").textContent()).trim();
        if (gs.includes("joined") || gs.includes("host")) break;
        await wait(500);
      }
      console.log("PROBE3 trusted join click:", trustedGuestClick, "| guest status:", gs);
      checkProbe("PROBE3 guest joins", gs.includes("joined") || gs.includes("host"), gs);

      // Roster + convergence on both pages.
      const hroster = await host.locator(".mp-peer").count();
      const groster = await guest.locator(".mp-peer").count();
      await wait(1500);
      const hgen = Number(await host.locator("#generation").textContent());
      const ggen = Number(await guest.locator("#generation").textContent());
      console.log(`PROBE3 rosters h=${hroster} g=${groster} gens h=${hgen} g=${ggen}`);
      checkProbe("PROBE3 both peers + converging gens", hroster >= 1 && groster >= 1 && hgen > 0 && ggen > 0, `h=${hroster} g=${groster} gh=${hgen} gg=${ggen}`);
      console.log("PROBE3 page errors:", [...herr, ...gerr]);
      checkProbe("PROBE3 no page errors", herr.length === 0 && gerr.length === 0, [...herr, ...gerr].join(" | "));

      // Leave + create again from the SAME host session (reviewer's fix).
      let trustedLeave = "ok";
      try {
        await host.click("#mp-leave", { timeout: 8000, force: false });
      } catch (e) {
        trustedLeave = `timeout:${e.name}`;
        await host.evaluate(() => document.querySelector("#mp-leave").click());
      }
      await wait(900);
      const leftStatus = (await host.locator("#mp-status").textContent()).trim();
      console.log("PROBE3 leave:", trustedLeave, "| status after leave:", leftStatus);
      checkProbe("PROBE3 host leaves", leftStatus.includes("left"), leftStatus);
      // Guest roster in Room A must be empty after the host left (no stale peer).
      await wait(800);
      const stalePeers = await guest.locator(".mp-peer").count();
      console.log("PROBE3 guest roster after host left (Room A):", stalePeers);
      checkProbe("PROBE3 no stale peer after host left", stalePeers === 0, `peers=${stalePeers}`);

      let trustedCreate2 = "ok";
      try {
        await host.click("#mp-create", { timeout: 8000, force: false });
      } catch (e) {
        trustedCreate2 = `timeout:${e.name}`;
        await host.evaluate(() => document.querySelector("#mp-create").click());
      }
      await wait(1200);
      const codeB = (await host.locator(".mp-code").textContent()).trim();
      const hostBStatus = (await host.locator("#mp-status").textContent()).trim();
      console.log("PROBE3 create B:", trustedCreate2, "| codeB:", codeB, "| status:", hostBStatus);
      checkProbe("PROBE3 host creates Room B from same session", codeB !== code && hostBStatus.includes("host"), `${codeB} (A=${code}) / ${hostBStatus}`);

      // A third guest joins Room B.
      const g2P = newPage(browser, server.appUrl);
      const { ctx: hctx2, page: guest2, errors: g2err } = await g2P;
      await guest2.evaluate(() => {
        window.__life3dOnboarding?.dismiss?.();
        window.__life3dOnboarding?.destroy?.();
        document.querySelector(".ob-wrap")?.setAttribute("hidden", "");
      });
      await wait(300);
      await guest2.fill("#mp-join-code", codeB);
      let tg2 = "ok";
      try {
        await guest2.click("#mp-join", { timeout: 8000, force: false });
      } catch (e) {
        tg2 = `timeout:${e.name}`;
        await guest2.evaluate(() => document.querySelector("#mp-join").click());
      }
      let g2s = "connecting";
      for (let i = 0; i < 40; i++) {
        g2s = (await guest2.locator("#mp-status").textContent()).trim();
        if (g2s.includes("joined") || g2s.includes("host")) break;
        await wait(500);
      }
      console.log("PROBE3 guest2 join:", tg2, "| status:", g2s);
      checkProbe("PROBE3 guest joins Room B", g2s.includes("joined") || g2s.includes("host"), g2s);
      const hB = await host.locator(".mp-peer").count();
      console.log("PROBE3 host B roster:", hB, "| errors:", [...herr, ...gerr, ...g2err]);
      checkProbe("PROBE3 room B roster + no errors", hB >= 1 && herr.length === 0 && gerr.length === 0 && g2err.length === 0, `peers=${hB}`);

      await hctx.close();
      await gctx.close();
      await hctx2.close();
    }
  } finally {
    await browser.close();
    server.cleanup();
  }
  console.log(probeFailures === 0 ? "ALL PROBES PASSED" : `${probeFailures} PROBE(S) FAILED`);
  process.exit(probeFailures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});