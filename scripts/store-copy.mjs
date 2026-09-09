#!/usr/bin/env node
/**
 * Emit exactly what goes into the Chrome Web Store dashboard, and nothing else.
 *
 * Run:  npm run store:copy
 *
 * store-listing/description.md deliberately mixes the store copy with internal
 * notes — the naming rules, the localisation rationale, the held Pro block. All
 * useful, none of it for the public listing. Asking someone to eyeball the
 * boundary invites pasting a code comment into a product page, so the copy is
 * extracted between explicit markers instead.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store-listing/dashboard-paste');

const md = await readFile(path.join(ROOT, 'store-listing/description.md'), 'utf8');
const m = md.match(/<!-- PASTE:BEGIN[\s\S]*?-->\n([\s\S]*?)<!-- PASTE:END -->/);
if (!m) {
  console.error('No PASTE:BEGIN / PASTE:END markers in store-listing/description.md.');
  process.exit(1);
}
const description = m[1].trim();

// Sanity: internal notes must never leak into the public copy.
const leaks = [
  ['a markdown heading', /^#{1,6}\s/m],
  ['an HTML comment', /<!--/],
  ['a file path', /\b(scripts|store-listing|backend)\//],
  ['a code identifier', /PRO_ENABLED|__MSG_|_locales|npm run/]
];
const found = leaks.filter(([, re]) => re.test(description)).map(([label]) => label);
if (found.length) {
  console.error(`The extracted copy contains ${found.join(', ')} — internal notes have leaked past the markers.`);
  process.exit(1);
}

const en = JSON.parse(await readFile(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'detailed-description.txt'), description + '\n', 'utf8');

console.log('Paste these into the Chrome Web Store dashboard:\n');
console.log('  Title            DO NOT TYPE — populates from the manifest via _locales');
console.log(`                   (en resolves to: ${en.extName.message})`);
console.log(`  Short descr.     DO NOT TYPE — also from _locales`);
console.log(`                   (en resolves to: ${en.extDescription.message})`);
console.log('');
console.log('  Detailed description:');
console.log('    store-listing/dashboard-paste/detailed-description.txt');
console.log(`    ${description.length} chars (limit 16,000) — paste the WHOLE file`);
console.log('');
console.log('  Privacy policy   https://ad-interceptor.pages.dev/privacy-policy');
console.log('  Data disclosure  "collects nothing" — PRO_ENABLED is false and the');
console.log('                   package audit proves no outbound network code');
