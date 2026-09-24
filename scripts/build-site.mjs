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
 * has to satisfy the merchant of record's domain review, which requires a product page,
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
  legalName: 'your full legal name — the merchant of record wants the sole trader\'s legal name in the Terms',
  processorName: 'the payment processor (NOT a merchant of record — the seller of record is legalName)',
  jurisdiction: 'the country whose law governs the Terms, e.g. "India"',
  webStoreUrl: 'the public Chrome Web Store listing — a site that sells a product must show where to get it'
};

const missing = Object.entries(REQUIRED).filter(([k]) => !String(seller[k] ?? '').trim());
if (missing.length) {
  console.error('Cannot build the site — store-listing/web/seller.json is incomplete:\n');
  for (const [k, why] of missing) console.error(`  ✗ ${k}  (${why})`);
  console.error('\nFill those in and re-run. Nothing has been written.');
  process.exit(1);
}

// Consistency checks on the PayPal config.
//
// These exist because the previous integration shipped a page whose checkout
// disagreed with its own config more than once. A build that cannot be wrong
// beats a deploy that has to be remembered.
//
// There is less to check than there used to be: the plan id and the client
// secret live in the Worker, so the site cannot hold a stale copy of either.
// What it CAN still get wrong is selling before anything is ready.
// The one-time checkout charges what the WORKER is configured with
// (PRO_PRICE_USD in backend/wrangler.jsonc), not what this page says. If the
// two disagree, the page advertises one price and PayPal charges another.
{
  const worker = await readFile(path.join(ROOT, 'backend', 'wrangler.jsonc'), 'utf8');
  const m = worker.match(/"PRO_PRICE_USD":\s*"([^"]+)"/);
  if (!m) {
    console.error('Refusing to build: backend/wrangler.jsonc has no PRO_PRICE_USD.');
    process.exit(1);
  }
  if (m[1] !== seller.priceUSD) {
    console.error(`Refusing to build: price drift — seller.json priceUSD is ${seller.priceUSD},`);
    console.error(`the Worker charges PRO_PRICE_USD ${m[1]}. Change both, then redeploy the Worker.`);
    process.exit(1);
  }
}

{
  const env = seller.paypalEnv;
  if (env !== 'sandbox' && env !== 'live') {
    console.error(`paypalEnv must be "sandbox" or "live", got ${JSON.stringify(env)}.`);
    process.exit(1);
  }

  if (seller.salesEnabled === true) {
    // The buy button is useless without the API — checkout is now a POST to
    // apiBase, not a static link, so an empty apiBase is not a degraded
    // checkout, it is no checkout at all.
    if (!seller.apiBase) {
      console.error('Refusing to build: salesEnabled is true but apiBase is empty.');
      console.error('The Get Pro button POSTs to apiBase + /v1/checkout/paypal-order; with no');
      console.error('apiBase there is nothing to post to and the button cannot work.');
      process.exit(1);
    }
    if (env !== 'live') {
      console.error(`Refusing to build: salesEnabled is true while paypalEnv is "${env}".`);
      console.error('That sells to real customers through a sandbox checkout — they pay');
      console.error('nothing, and the licence they receive is backed by no money.');
      process.exit(1);
    }
  }

  // apiBase is load-bearing in a way it was not under the static-link model,
  // so sanity-check its shape rather than discovering it at runtime.
  if (seller.apiBase && !/^https:\/\/[a-z0-9.-]+$/.test(seller.apiBase)) {
    console.error(`apiBase is not a plausible origin (no trailing slash or path): ${JSON.stringify(seller.apiBase)}`);
    process.exit(1);
  }
}

const tokens = {
  ...seller,
  ruleCount: group(counts.freeNetwork),
  ruleCountRounded: `${group(Math.floor(counts.freeNetwork / 1000) * 1000)}+`,
  cosmeticCount: group(counts.cosmeticGeneric),
  // Pro annoyance counts, same rule as every other figure on the site: derived
  // from the last build, never typed into the page. `?? 0` covers a
  // counts.json written before these tiers existed, so an old file degrades to
  // a visible zero rather than the string "undefined".
  cookieCount: group((counts.cookieNetwork ?? 0) + (counts.cookieCosmetic ?? 0)),
  annoyCount: group((counts.annoyNetwork ?? 0) + (counts.annoyCosmetic ?? 0)),
  // Rendered into the page as a JS boolean, so the checkout can degrade to a
  // "contact us" state rather than throwing when it is not configured yet.
  //
  // Under the static-link model this meant "is there a product id". Now the
  // only thing the PAGE needs is somewhere to post: the Worker holds the plan
  // id and the credentials, and answers 503 if either is missing.
  checkoutEnabled: Boolean(seller.apiBase),
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

// A merchant-of-record domain review checks for these by navigation, so a missing file is
// a failed review, not a cosmetic gap.
// A 404.html matters more than it looks: without one, Cloudflare Pages was
// answering EVERY unmatched path with 200 and the root document. Before this
// site existed that meant /pricing, /terms and /refunds all served the privacy
// policy with a success status — a domain reviewer following a link would see
// the wrong page and no error. A real 404 fails honestly instead.
for (const required of ['index.html', '404.html', 'pricing.html', 'terms.html', 'refunds.html', 'privacy-policy.html']) {
  if (!pages.includes(required) && required !== 'privacy-policy.html') {
    problems.push(`missing ${required} — merchant-of-record domain review requires it`);
  }
}

// The post-payment receipt view must be handled BEFORE any gate that returns
// early.
//
// This shipped broken once: the redirect after payment carried no ?test=1, so
// the sandbox gate fired, printed "Not on sale yet" and returned before the
// recover handler ran. A paying customer saw a pricing page and no licence
// key.
//
// The sandbox gate is gone with Paddle, but the hazard is NOT — the
// SALES_ENABLED gate returns early too, and Dodo's redirect lands on
// ?payment_id=..., which carries no test flag either. Exactly the same bug,
// one gate along. Ordering inside a single <script> is invisible to every
// other check here, so assert it explicitly.
{
  const pricing = await readFile(path.join(OUT, 'pricing.html'), 'utf8');
  const iRecover = pricing.indexOf('A receipt view needs no checkout');
  const iCopy = pricing.indexOf('copyBtn.addEventListener');
  const iDownload = pricing.indexOf('downloadBtn.addEventListener');

  const iSales = pricing.indexOf('if (!SALES_ENABLED)');
  if (iSales === -1) problems.push('pricing.html: the SALES_ENABLED gate is missing');
  if (seller.salesEnabled === true) {
    console.log('  ⚠  salesEnabled is TRUE — the buy button is live. Only correct if a');
    console.log('     PRO_ENABLED extension build is already published in the store.');
  }

  if (iRecover === -1) problems.push('pricing.html: no recover early-return found');
  if (iRecover > -1 && iSales > -1 && iRecover > iSales) {
    problems.push('pricing.html: the SALES_ENABLED gate runs BEFORE the receipt handler — a paying customer would see "Not on sale yet" instead of their key');
  }

  // The redirect back from checkout is the ONLY way a buyer reaches their key
  // without an email pipeline. If the page stops reading subscription_id,
  // every purchase silently ends on a pricing page.
  if (!pricing.includes("params.get('subscription_id')")) {
    problems.push('pricing.html: the post-checkout ?subscription_id= handler is missing');
  }

  // The buy button is a POST to our own Worker now, not a static link. If that
  // call goes missing the button renders and does nothing, which is worse than
  // a button that admits it is unconfigured.
  if (!pricing.includes("'/v1/checkout/paypal-order'")) {
    problems.push('pricing.html: the /v1/checkout/paypal-order call is missing — the buy button would do nothing');
  }
  if (!pricing.includes("'/v1/checkout/paypal-order/capture'")) {
    problems.push('pricing.html: the capture call is missing — a buyer returning from PayPal would never be charged or get a key');
  }

  // Asserting the negative, because this is the claim the product is sold on
  // and PayPal's own docs recommend the thing that would break it.
  if (/paypal\.com\/sdk|paypalobjects\.com/i.test(pricing)) {
    problems.push("pricing.html: loads PayPal's SDK — the privacy policy says the page loads no third-party resource");
  }

  // The claim "no third-party resources" is made in the privacy policy and is
  // the product's main selling point. Assert it rather than trusting it.
  if (/<script[^>]+src=["']https?:/i.test(pricing)) {
    problems.push('pricing.html: loads a third-party script — the privacy policy says it loads none');
  }
  // The key panel's buttons are useless if their listeners sit behind a gate
  // that returns early — the receipt view needs them and never reaches past it.
  for (const [name, idx] of [['copy', iCopy], ['download', iDownload]]) {
    if (idx === -1) problems.push(`pricing.html: no ${name} listener found`);
    else if (iSales > -1 && idx > iSales) {
      problems.push(`pricing.html: the ${name} listener is registered after the SALES_ENABLED gate, so it never attaches`);
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
console.log(`  checkout     : ${tokens.checkoutEnabled ? `${seller.paypalEnv} one-time via ${seller.apiBase}/v1/checkout/paypal-order` : 'NOT configured'}`);
console.log(`  seller of rec: ${seller.legalName} — payments via ${seller.processorName}`);
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
if (seller.paypalEnv === 'live' && seller.salesEnabled !== true) {
  console.log('');
  console.log('  ############################################################');
  console.log('  #  LIVE checkout config staged, sales still OFF.           #');
  console.log('  #                                                          #');
  console.log('  #  salesEnabled is false, so the Get Pro button renders as  #');
  console.log('  #  "Not on sale yet". That is correct until a PRO_ENABLED   #');
  console.log('  #  build is PUBLISHED in the Chrome Web Store — selling      #');
  console.log('  #  before then hands buyers a key the shipped extension     #');
  console.log('  #  cannot activate.                                         #');
  console.log('  ############################################################');
  console.log('');
}
console.log('Site check passed.');
