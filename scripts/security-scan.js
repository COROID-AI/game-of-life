#!/usr/bin/env node
/*
 * Security scan for the Game of Life single-file app.
 *
 * The app must be fully offline and self-contained by design:
 *   - no external network requests (no CDN, fetch, XHR, WebSocket, import)
 *   - no dynamic code execution (eval, new Function, document.write)
 *   - no inline event handlers (onclick= etc.), which enable XSS vectors
 *   - no console.* calls (clean production output)
 *   - the inline <script> must parse as valid JavaScript
 *
 * Exits 0 on pass, 1 on failure. Prints a report to stdout.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const findings = [];
let checks = 0;

function check(name, ok, detail) {
  checks++;
  const line = (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : '');
  console.log(line);
  if (!ok) findings.push(name + (detail ? ' — ' + detail : ''));
}

// 1. External network references (http/https URLs, fetch, XHR, WebSocket, imports)
const netPatterns = [
  { re: /https?:\/\//g, label: 'http(s) URL' },
  { re: /(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/g, label: 'network API call' },
  { re: /import\s*\(/g, label: 'dynamic import' },
  { re: /<script[^>]*\bsrc=/gi, label: 'external script src' },
];
let netHits = [];
for (const p of netPatterns) {
  let m;
  while ((m = p.re.exec(html)) !== null) netHits.push(p.label + ' @ ' + m.index);
}
check('No external network references', netHits.length === 0, netHits.slice(0, 3).join(', '));

// 2. Dynamic code execution
const dynPatterns = [
  { re: /\beval\s*\(/g, label: 'eval(' },
  { re: /\bnew\s+Function\s*\(/g, label: 'new Function(' },
  { re: /document\.write\s*\(/g, label: 'document.write(' },
];
let dynHits = [];
for (const p of dynPatterns) {
  let m;
  while ((m = p.re.exec(html)) !== null) dynHits.push(p.label + ' @ ' + m.index);
}
check('No dynamic code execution', dynHits.length === 0, dynHits.slice(0, 3).join(', '));

// 3. Inline event handlers
const inlineHandler = /<[a-zA-Z][^>]*\son[a-z]+\s*=/gi;
let ih;
const ihHits = [];
while ((ih = inlineHandler.exec(html)) !== null) ihHits.push('@ ' + ih.index);
check('No inline event handlers', ihHits.length === 0, ihHits.slice(0, 3).join(', '));

// 4. No console.* in the app script
const consoleHits = [];
const consoleRe = /\bconsole\.\w+\s*\(/g;
let cm;
while ((cm = consoleRe.exec(html)) !== null) consoleHits.push('@ ' + cm.index);
check('No console.* calls in app', consoleHits.length === 0, consoleHits.slice(0, 3).join(', '));

// 5. Single inline script block, correctly closed
const scriptTags = (html.match(/<script[\s\S]*?<\/script>/g) || []).length;
check('Exactly one inline script block', scriptTags === 1, scriptTags + ' block(s)');

// 6. The inline script parses as valid JavaScript (node --check)
const m = html.match(/<script>([\s\S]*?)<\/script>/);
let syntaxOk = false;
if (m) {
  const tmp = path.join(require('os').tmpdir(), 'gol-scan-script-' + process.pid + '.js');
  fs.writeFileSync(tmp, m[1]);
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  syntaxOk = r.status === 0;
}
check('Inline script parses (node --check)', syntaxOk, '');

// 7. Required grading hook present
check('window.gameOfLifeStep hook exposed', /window\.gameOfLifeStep\s*=/.test(html), '');

// 8. No external stylesheets or fonts
const extCss = /<link[^>]*rel=["']stylesheet["']/gi.test(html);
const extFont = /@font-face/gi.test(html) || /fonts\.googleapis/gi.test(html);
check('No external stylesheets or fonts', !extCss && !extFont, '');

// 9. No <iframe> or <object>/<embed> (self-contained page)
const embeds = /<(?:iframe|object|embed)\b/gi.test(html);
check('No iframes or embedded objects', !embeds, '');

console.log('\nSecurity scan: ' + (findings.length === 0 ? 'PASS' : findings.length + ' finding(s)'));
process.exit(findings.length === 0 ? 0 : 1);