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

// --- permission justifications, as plain text ---------------------------
// The source file uses markdown blockquotes so the paste-ready text stands out
// from the surrounding notes. Pasted into a dashboard textarea those "> "
// markers come along literally and pollute the field, so they are stripped
// here and each field written to its own file.
const pj = await readFile(path.join(ROOT, 'store-listing/permission-justifications.md'), 'utf8');
const slug = (h) => h.toLowerCase()
  .replace(/permission:\s*/, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

const fields = [];
// Split on ## / ### headings and keep only the blockquoted body of each.
const sections = pj.split(/\n(?=#{2,3} )/);
for (const sec of sections) {
  const heading = (sec.match(/^#{2,3} (.+)$/m) || [])[1];
  if (!heading) continue;
  const quoted = sec
    .split('\n')
    .filter((l) => l.startsWith('>'))
    .map((l) => l.replace(/^>\s?/, ''))
    .join('\n')
    .trim();
  if (!quoted) continue;
  if (/^>/.test(quoted)) continue;
  fields.push({ heading, slug: slug(heading), text: quoted });
}

const en = JSON.parse(await readFile(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));

// The dashboard answers below depend on whether this build ships Pro. Read the
// flag rather than hardcoding the answer: the hardcoded "collects nothing" line
// outlived PRO_ENABLED = true, and pasting it would be a false declaration.
const configSrc = await readFile(path.join(ROOT, 'config.js'), 'utf8');
const proMatch = configSrc.match(/export const PRO_ENABLED\s*=\s*(true|false)/);
if (!proMatch) {
  console.error('Could not read PRO_ENABLED from config.js.');
  process.exit(1);
}
const PRO = proMatch[1] === 'true';

// The Pro copy and the Pro build must travel together, in both directions.
const describesPro = /AD INTERCEPTOR PRO/.test(description);
if (describesPro !== PRO) {
  console.error(PRO
    ? 'PRO_ENABLED is true but the description has no Pro section, and still promises no network requests.'
    : 'PRO_ENABLED is false but the description advertises Pro — the package cannot do what the listing says.');
  process.exit(1);
}

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
console.log('  Privacy practices tab — paste each of these files:');
for (const f of fields) {
  const file = `permission-${f.slug}.txt`;
  await writeFile(path.join(OUT, file), f.text + '\n', 'utf8');
  console.log(`    ${f.heading}`);
  console.log(`      dashboard-paste/${file}  (${f.text.length} chars)`);
}
console.log('');
if (PRO) {
  console.log('  Payments         "Contains in-app purchases".');
  console.log('  Data collection  tick ONLY "Authentication information" —');
  console.log('                   the licence key sent to the licence server.');
  console.log('                   Purpose: App functionality. Leave every other');
  console.log('                   category unticked; keep all three certifications.');
} else {
  console.log('  Payments         "Free of charge".');
  console.log('  Data collection  NONE — leave every category unchecked.');
}
console.log('  Remote code      No.');
console.log('');
console.log('  Privacy policy   https://ad-interceptor.pages.dev/privacy-policy');
console.log(PRO
  ? '  Build            Pro (PRO_ENABLED = true) — upload the -pro.zip'
  : '  Build            free (PRO_ENABLED = false) — the package audit proves no outbound network code');
