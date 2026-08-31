#!/usr/bin/env node
/**
 * Stage the public site into site/ for hosting (Cloudflare Pages, etc.).
 *
 * Run:  npm run site
 *
 * LIVE AT: https://ad-interceptor.pages.dev  (Cloudflare Pages project
 * "ad-interceptor", personal account). Redeploy with:
 *   npm run site && npx wrangler pages deploy site --project-name=ad-interceptor
 *
 * The privacy policy has to live at a stable public URL for as long as the
 * extension is listed — Chrome Web Store re-checks it, and a 404 can get a live
 * listing pulled long after launch. Generating site/ from the canonical file in
 * store-listing/ means the hosted copy can never drift from the one under
 * review; edit store-listing/privacy-policy.html and re-run this.
 */
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'store-listing', 'privacy-policy.html');
const OUT = path.join(ROOT, 'site');

await mkdir(OUT, { recursive: true });

// Served at the site root, so the deploy URL itself is the policy URL — one
// less path to get wrong when pasting it into the store listing.
await copyFile(SRC, path.join(OUT, 'index.html'));

// Also keep the descriptive filename, so an existing /privacy-policy.html link
// keeps working if the URL is ever shared that way.
await copyFile(SRC, path.join(OUT, 'privacy-policy.html'));

// Static host, no crawl budget to protect — but be explicit rather than
// letting a host inject its own default.
await writeFile(path.join(OUT, 'robots.txt'), 'User-agent: *\nAllow: /\n', 'utf8');

const html = await readFile(SRC, 'utf8');
const hasDoctype = html.trimStart().startsWith('<!DOCTYPE');
const hasContact = html.includes('mailto:');

console.log(`Staged site/ from store-listing/privacy-policy.html`);
console.log(`  doctype present : ${hasDoctype ? 'yes' : 'NO — will render in quirks mode'}`);
console.log(`  contact address : ${hasContact ? 'yes' : 'NO — Chrome Web Store requires one'}`);
if (!hasDoctype || !hasContact) process.exit(1);
