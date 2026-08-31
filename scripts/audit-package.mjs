#!/usr/bin/env node
/**
 * Audit a staged FREE build: assert it contains no outbound network code.
 *
 * Usage: node scripts/audit-package.mjs <stage-dir>
 *
 * The free build's Chrome Web Store data disclosure says "collects nothing".
 * This checks that against the actual files about to be zipped, so the claim
 * cannot quietly stop being true — a stray fetch() to an external host fails
 * the build instead of shipping and contradicting the disclosure.
 *
 * Comments are stripped before checking. A spec link in a comment is not
 * network code, and failing on those just trains people to ignore the audit.
 *
 * rules/ and filters/ are skipped: they are filter DATA, and are full of
 * ad-network URLs by definition. Only executable code is audited.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const stage = process.argv[2];
if (!stage) {
  console.error('usage: audit-package.mjs <stage-dir>');
  process.exit(2);
}

const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
    .replace(/^\s*\/\/.*$/gm, '')      // whole-line comments
    .replace(/\/\/.*$/gm, '');         // trailing comments

const problems = [];

for (const name of readdirSync(stage)) {
  if (!/\.(js|html)$/.test(name)) continue;
  const code = stripComments(readFileSync(path.join(stage, name), 'utf8'));

  for (const m of code.match(/https?:\/\/[^\s'"`)]+/g) ?? []) {
    problems.push(`${name}: external URL ${m}`);
  }
  for (const api of ['XMLHttpRequest', 'sendBeacon', 'WebSocket(', 'EventSource(']) {
    if (code.includes(api)) problems.push(`${name}: uses ${api}`);
  }
  // fetch() is legitimate only for resources inside the package.
  for (const m of code.matchAll(/fetch\(([^)]*)/g)) {
    if (!m[1].includes('chrome.runtime.getURL')) {
      problems.push(`${name}: fetch() to non-packaged target: ${m[1].trim().slice(0, 60)}`);
    }
  }
}

for (const f of ['scriptlets.js', 'youtube.js']) {
  if (existsSync(path.join(stage, f))) problems.push(`${f} present in a free build`);
}

const lic = path.join(stage, 'license.js');
if (existsSync(lic) && !readFileSync(lic, 'utf8').includes('license-stub.js')) {
  problems.push('license.js is the real module, not the stub');
}

if (problems.length) {
  console.error('AUDIT FAILED:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('Audit passed: stub licence module, no outbound network code.');
