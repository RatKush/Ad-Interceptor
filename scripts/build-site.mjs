#!/usr/bin/env node
/**
 * Stage the public site into site/ for hosting on Cloudflare Pages.
 *
 * Run:  npm run site
 *
 * LIVE AT: https://ad-interceptor.pages.dev  (Pages project "ad-interceptor",
 * personal account). Deploy with:
 *   npm run site && npx wrangler pages deploy site --project-name=ad-interceptor
 *
 * WHAT THIS SITE IS FOR
 * Originally it existed only to host the privacy policy at a stable URL, which
 * the Chrome Web Store requires for as long as the item is listed. It now also
 * has to satisfy Paddle's domain review, which requires a product page,
 * pricing, Terms & Conditions and a Refund Policy reachable by navigation
 * (see store-listing/paddle-verification.md).
 *
 * ⚠️  READ THIS BEFORE THE FIRST DEPLOY OF THE NEW SITE
 * The root URL used to serve the privacy policy, and that root URL is what is
 * currently pasted into the Chrome Web Store's "Privacy policy" field. The root
 * is now the LANDING page, so deploying without acting first would leave the
 * store pointing at a page that is not a privacy policy — which risks the live
 * listing, months after launch, for no benefit.
 *
 * Correct order, and it matters:
 *   1. In the Chrome Web Store dashboard, change the Privacy policy URL to
 *      https://ad-interceptor.pages.dev/privacy-policy and save. That URL
 *      already serves the policy today, so this is safe to do first.
 *   2. THEN deploy this site.
 *
 * Doing it in that order means the store never points at the wrong page.
 */
import { mkdir, copyFile, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'store-listing', 'web');
const POLICY = path.join(ROOT, 'store-listing', 'privacy-policy.html');
const OUT = path.join(ROOT, 'site');

const seller = JSON.parse(await readFile(path.join(WEB, 'seller.json'), 'utf8'));

// Rule counts come from the last `npm run build`, never from a literal in a
// page. Upstream filter lists grow and shrink, and a hardcoded figure becomes
// a false claim the moment they do.
let counts;
try {
  counts = JSON.parse(await readFile(path.join(ROOT, 'filters/counts.json'), 'utf8'));
} catch {
  console.error('filters/counts.json is missing — run `npm run build` first.');
  process.exit(1);
}
const group = (n) => Number(n).toLocaleString('en-US');

// Details only the owner can supply. The build refuses to run without them,
// rather than publishing legal pages that say "{{legalName}}" — the same guard
// as config.js's API_BASE, for the same reason: a placeholder that reaches
// production is a placeholder nobody checked.
const REQUIRED = {
  legalName: 'your full legal name — Paddle wants the sole trader\'s legal name in the Terms',
  jurisdiction: 'the country whose law governs the Terms, e.g. "India"'
};

const missing = Object.entries(REQUIRED).filter(([k]) => !String(seller[k] ?? '').trim());
if (missing.length) {
  console.error('Cannot build the site — store-listing/web/seller.json is incomplete:\n');
  for (const [k, why] of missing) console.error(`  ✗ ${k}  (${why})`);
  console.error('\nFill those in and re-run. Nothing has been written.');
  process.exit(1);
}

// Consistency checks on the Paddle config. A sandbox token on a production
// build takes real money nowhere; a live token on a sandbox build takes real
// money for real. Both are silent at runtime, so catch them here.
if (seller.paddleClientToken) {
  const env = seller.paddleEnvironment;
  const tok = seller.paddleClientToken;
  if (env === 'production' && tok.startsWith('test_')) {
    console.error(`Refusing to build: paddleEnvironment is "production" but the client token is a sandbox token (${tok.slice(0, 5)}...).`);
    process.exit(1);
  }
  if (env === 'sandbox' && tok.startsWith('live_')) {
    console.error('Refusing to build: paddleEnvironment is "sandbox" but the client token is a LIVE token. A real card would be charged.');
    process.exit(1);
  }
  if (!['sandbox', 'production'].includes(env)) {
    console.error(`paddleEnvironment must be "sandbox" or "production", got ${JSON.stringify(env)}.`);
    process.exit(1);
  }
  if (!/^pri_[a-z0-9]{26}$/.test(seller.paddlePriceId ?? '')) {
    console.error(`paddlePriceId does not look like a Paddle price id: ${JSON.stringify(seller.paddlePriceId)}`);
    process.exit(1);
  }
}

const tokens = {
  ...seller,
  ruleCount: group(counts.freeNetwork),
  ruleCountRounded: `${group(Math.floor(counts.freeNetwork / 1000) * 1000)}+`,
  cosmeticCount: group(counts.cosmeticGeneric),
  // Rendered into the page as a JS boolean, so the checkout can degrade to a
  // "contact us" state rather than throwing when it is not configured yet.
  checkoutEnabled: Boolean(seller.paddleClientToken && seller.paddlePriceId),
  lastUpdated: new Date().toISOString().slice(0, 10)
};

/** Replace {{token}} everywhere, and fail loudly on any that has no value. */
function fill(html, filename) {
  const out = html.replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key]) : whole
  );
  const leftover = [...new Set((out.match(/\{\{\w+\}\}/g) ?? []))];
  if (leftover.length) {
    console.error(`Unresolved placeholders in ${filename}: ${leftover.join(', ')}`);
    process.exit(1);
  }
  return out;
}

await mkdir(OUT, { recursive: true });

// --- templated pages -------------------------------------------------------
const pages = (await readdir(WEB)).filter((f) => f.endsWith('.html'));
for (const name of pages) {
  const src = await readFile(path.join(WEB, name), 'utf8');
  await writeFile(path.join(OUT, name), fill(src, name), 'utf8');
}
await copyFile(path.join(WEB, 'site.css'), path.join(OUT, 'site.css'));

// --- privacy policy --------------------------------------------------------
// Copied verbatim, NOT templated. It is the document Chrome Web Store review
// points at; it stays byte-identical to the file under review so the hosted
// copy can never drift from it. Edit store-listing/privacy-policy.html.
await copyFile(POLICY, path.join(OUT, 'privacy-policy.html'));

await writeFile(path.join(OUT, 'robots.txt'), 'User-agent: *\nAllow: /\n', 'utf8');

// --- checks ----------------------------------------------------------------
const policyHtml = await readFile(POLICY, 'utf8');
const problems = [];

if (!policyHtml.trimStart().startsWith('<!DOCTYPE')) problems.push('privacy policy has no doctype (renders in quirks mode)');
if (!policyHtml.includes('mailto:')) problems.push('privacy policy has no contact address (Chrome Web Store requires one)');

// Paddle's domain review checks for these by navigation, so a missing file is
// a failed review, not a cosmetic gap.
// A 404.html matters more than it looks: without one, Cloudflare Pages was
// answering EVERY unmatched path with 200 and the root document. Before this
// site existed that meant /pricing, /terms and /refunds all served the privacy
// policy with a success status — a domain reviewer following a link would see
// the wrong page and no error. A real 404 fails honestly instead.
for (const required of ['index.html', '404.html', 'pricing.html', 'terms.html', 'refunds.html', 'privacy-policy.html']) {
  if (!pages.includes(required) && required !== 'privacy-policy.html') {
    problems.push(`missing ${required} — Paddle domain review requires it`);
  }
}

// The post-payment receipt view must be handled BEFORE the sandbox purchase
// gate, which returns early.
//
// This shipped broken once: the redirect after payment lands on
// ?recover=<txn> and so carries no ?test=1, the gate fired, printed "Not on
// sale yet" and returned before the recover handler ran. A paying customer
// saw a pricing page and no licence key. Ordering inside one <script> is
// invisible to every other check here, so assert it explicitly.
{
  const pricing = await readFile(path.join(OUT, 'pricing.html'), 'utf8');
  const iRecover = pricing.indexOf('A receipt view needs no checkout');
  const iGate = pricing.indexOf("PADDLE_ENV === 'sandbox' && !testing");
  const iCopy = pricing.indexOf('copyBtn.addEventListener');
  const iDownload = pricing.indexOf('downloadBtn.addEventListener');

  if (iRecover === -1) problems.push('pricing.html: no recover early-return found');
  if (iGate === -1) problems.push('pricing.html: no sandbox purchase gate found');
  if (iRecover > -1 && iGate > -1 && iRecover > iGate) {
    problems.push('pricing.html: the sandbox gate runs BEFORE the ?recover= handler — a paying customer would see no key');
  }
  // The key panel's buttons are useless if their listeners sit behind a gate.
  for (const [name, idx] of [['copy', iCopy], ['download', iDownload]]) {
    if (idx === -1) problems.push(`pricing.html: no ${name} listener found`);
    else if (iGate > -1 && idx > iGate) {
      problems.push(`pricing.html: the ${name} listener is registered after the sandbox gate, so it never attaches`);
    }
  }
}

// Every page must reach every other one, or "clearly accessible via
// navigation" is not satisfied.
for (const name of pages) {
  const html = await readFile(path.join(OUT, name), 'utf8');
  for (const link of ['/pricing', '/terms', '/refunds', '/privacy-policy']) {
    if (!html.includes(`href="${link}"`)) problems.push(`${name} does not link to ${link}`);
  }
}

const staged = [...pages, 'privacy-policy.html', 'site.css', 'robots.txt'];
console.log('Staged site/ :');
for (const f of [...new Set(staged)].sort()) console.log(`  ${f}`);
console.log('');
console.log(`  seller       : ${seller.legalName} (${seller.jurisdiction})`);
console.log(`  Pro price    : $${seller.priceUSD}/yr, ${seller.deviceLimit} devices`);
console.log(`  refund window: ${seller.refundDays} days`);
console.log(`  rule counts  : ${group(counts.freeNetwork)} network, ${group(counts.cosmeticGeneric)} cosmetic (built ${counts.builtAt})`);
console.log(`  checkout     : ${tokens.checkoutEnabled ? `${seller.paddleEnvironment} (${seller.paddlePriceId})` : 'NOT configured'}`);
console.log(`  licence API  : ${seller.apiBase || 'NOT set — keys must be issued by hand'}`);

if (problems.length) {
  console.error('\nSite check FAILED:');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log('');
console.log('  ⚠  Cloudflare Pages strips .html, so pages serve at /pricing, /terms,');
console.log('     /refunds, /privacy-policy. Before the FIRST deploy of this site,');
console.log('     change the Chrome Web Store Privacy policy field to');
console.log('     https://ad-interceptor.pages.dev/privacy-policy — the root is now');
console.log('     the landing page. Update the store field first, then deploy.');
console.log('');
console.log('Site check passed.');
