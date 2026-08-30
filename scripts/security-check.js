#!/usr/bin/env node
'use strict';

/**
 * Static security verification for the single-file Game of Life app.
 *
 * The app must run fully offline from file:// with zero network requests,
 * no dynamic code execution, and no external asset references. This script
 * greps index.html for the antipatterns that would break that guarantee.
 *
 * Exit code 0 = PASS, 1 = FAIL.
 */

const fs = require('fs');
const path = require('path');

const appFile = path.join(__dirname, '..', 'index.html');

const failures = [];

if (!fs.existsSync(appFile)) {
  console.error('FAIL: index.html not found at ' + appFile);
  process.exit(1);
}

const html = fs.readFileSync(appFile, 'utf8');

// 1. No external network resource references.
//    src/href/css url() pointing at http(s):// or protocol-relative // hosts.
//    The inline SVG data-URI favicon contains the XML namespace
//    xmlns="http://www.w3.org/2000/svg" which is NOT a network request,
//    so it is excluded explicitly.
const externalRefRe = /(?:src|href|action|poster|srcset)\s*=\s*["'](?:https?:)?\/\//gi;
const cssUrlRe = /url\(\s*["']?(?:https?:)?\/\//gi;
const stripped = html.replace(/xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/gi, '');
const refs = (stripped.match(externalRefRe) || []).concat(stripped.match(cssUrlRe) || []);
if (refs.length) {
  failures.push('External resource reference(s) found: ' + refs.join(', '));
}

// 2. No dynamic code execution.
const dynamicRe = /\beval\s*\(|\bnew\s+Function\s*\(|\bdocument\.write\s*\(/g;
const dynamic = html.match(dynamicRe) || [];
if (dynamic.length) {
  failures.push('Dynamic code execution found: ' + dynamic.join(', '));
}

// 3. No network-capable APIs.
const netRe = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bimportScripts\s*\(/g;
const net = html.match(netRe) || [];
if (net.length) {
  failures.push('Network-capable API found: ' + net.join(', '));
}

// 4. No external <script src=...> or <link href="http...">.
if (/<script[^>]*\bsrc\s*=/i.test(html)) {
  failures.push('External <script src> found');
}
if (/<link[^>]*\bhref\s*=\s*["']https?:/i.test(html)) {
  failures.push('External <link href> found');
}

// 5. No inline event handlers that could run untrusted strings.
const inlineHandlerRe = /\son(?:click|load|error|mouseover|mouseout|change|input|keydown|keyup)\s*=\s*["']/gi;
const handlers = html.match(inlineHandlerRe) || [];
if (handlers.length) {
  failures.push('Inline event handler attribute(s) found: ' + handlers.join(', '));
}

if (failures.length) {
  console.error('SECURITY CHECK FAILED:');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}

console.log('SECURITY CHECK PASSED: index.html is self-contained');
console.log('  - no external resource references');
console.log('  - no dynamic code execution');
console.log('  - no network-capable APIs');
console.log('  - no external scripts or stylesheets');
console.log('  - no inline event handlers');