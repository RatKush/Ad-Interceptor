#!/usr/bin/env node
/**
 * Build the extension's filter data from EasyList + EasyPrivacy.
 *
 * Run:  node scripts/build-filters.mjs
 *
 * Emits:
 *   rules/filters-N.json     - static DNR rulesets, ~20,000 rules each, and
 *                              the matching rule_resources block written back
 *                              into manifest.json
 *   filters/generic.css      - element-hiding CSS that applies to every site,
 *                              registered as a content-script stylesheet so it
 *                              costs no JS at page load
 *   filters/cosmetic.json    - the per-domain remainder, applied by cosmetic.js
 *
 * WHY CHUNKED RULESETS
 * GUARANTEED_MINIMUM_STATIC_RULES is 30,000, but that is a floor, not a cap -
 * the real allowance comes from a global pool shared across installed
 * extensions, and all 108,000 rules load fine on a normal profile (verified:
 * scripts/verify.mjs enables all 6 rulesets with ~222,000 quota to spare).
 * Shipping them in chunks lets background.js enable as many as each user's
 * live quota allows instead of us picking a number at build time.
 *
 * LICENSING
 * EasyList and EasyPrivacy are dual-licensed GPLv3 / CC BY-SA 3.0. This
 * project uses them under CC BY-SA 3.0 (attribution in ATTRIBUTION.md), which
 * covers the *list data* without imposing GPL terms on the extension source.
 * @adguard/dnr-converter is GPL-3.0 and is used here as a build-time-only
 * tool: it is a devDependency, its output is data, and it is never bundled
 * into the shipped package (see scripts/package.sh).
 */
import { FilterConverter, Filter } from '@adguard/dnr-converter';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRO_ENABLED } from '../config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Free tier: ads and trackers.
const FREE_SOURCES = [
  { name: 'easylist', url: 'https://easylist.to/easylist/easylist.txt' },
  { name: 'easyprivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
];

// Our own supplemental rules, kept in-repo rather than fetched. Listed first
// in the manifest and always enabled, so a fix for a user report can never be
// the ruleset that gets dropped when static quota runs short.
const CUSTOM_SOURCES = [
  { name: 'custom', file: 'filters/custom.txt' },
];

// Pro tier: the Adblock Warning Removal List — EasyList's dedicated
// anti-adblock list (same dual GPLv3 / CC BY-SA 3.0 licence, rebuilt daily).
//
// This is what makes Pro's "bypass anti-adblock walls" claim real. A
// hand-written per-domain scriptlet table was the alternative and it is not
// competitive: EasyList's own lists carry only 26 scriptlet rules between
// them, and uBlock's rich scriptlet lists are GPL, so the honest options were
// a guessed table or a maintained list. This is the maintained list.
const PRO_SOURCES = [
  { name: 'antiadblock', url: 'https://easylist-downloads.adblockplus.org/antiadblockfilters.txt' },
];

// Pro tier, part two: ANNOYANCES.
//
// Split into two independently toggleable lists rather than one "annoyances"
// blob, because the two fail differently and a user needs to be able to keep
// one while dropping the other:
//
//   cookies — hides consent dialogs. It HIDES them, it does not answer them.
//             Some sites will not load content until a choice is recorded, so
//             a user in the EU may genuinely want this off. (Clicking the
//             button for them is the other approach — see the note in
//             background.js on why we don't.)
//   annoy   — floating/sticky video players, newsletter modals, survey
//             overlays, app-install interstitials, in-page social widgets.
//             Much lower risk, and the part people actually mean by
//             "distraction control".
//
// LICENCE: both are EasyList-project lists, and both were checked against the
// licence line in their own headers rather than assumed:
//
//   Easylist Cookie List   — "! License: creativecommons.org/licenses/by/3.0/"
//                            CC BY 3.0: attribution, no share-alike.
//   Fanboy's Annoyance     — "! Licence: easylist.to/pages/licence.html"
//                            the usual dual GPLv3 / CC BY-SA 3.0; used here
//                            under CC BY-SA 3.0, exactly as EasyList itself is.
//
// AdGuard's annoyance filters are better in places but are GPL-3.0 only, which
// would impose GPL terms on this extension's source — the same reason
// @adguard/dnr-converter is a build-time devDependency that is never bundled.
//
// The cookie list is served from secure.fanboy.co.nz. That is not a third-party
// mirror: the file's own "! Title:" is "Easylist Cookie List" and it is the
// canonical download. The easylist-downloads.adblockplus.org and easylist.to
// paths for it both 404.
const COOKIE_SOURCES = [
  { name: 'easylist-cookie', url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt' },
];

const ANNOY_SOURCES = [
  { name: 'fanboy-annoyance', url: 'https://easylist.to/easylist/fanboy-annoyance.txt' },
];

// ---- BUDGET ---------------------------------------------------------------
// GUARANTEED_MINIMUM_STATIC_RULES is 30,000, but that is a floor, not a cap:
// getAvailableStaticRuleCount() reports ~300,000 further rules available from
// Chrome's shared global pool on a clean profile (measured, Edge 151). So the
// filters ship as several static rulesets and background.js enables as many as
// the *live* quota allows, instead of us guessing a limit at build time.
//
// Smaller chunks fit the available quota more precisely; the cost is more
// files. 20,000 is a reasonable middle.
const RULES_PER_CHUNK = 20000;

// Chrome allows at most 50 enabled rulesets and 100 declared.
const MAX_CHUNKS = 40;

// Cosmetic and scriptlet separators. These are not network rules; the DNR
// converter cannot express them, so they are split out before conversion.
const COSMETIC_SEPARATOR = /(#[@?$%]?#|#\$\?#|#@\$#)/;

// Rules whose action needs host permissions to evaluate ("unsafe" in Chrome's
// terms) are capped at 5,000 dynamic and complicate review. There are only a
// couple of them in these lists, so they are dropped rather than budgeted for.
const SAFE_ACTIONS = new Set(['block', 'allow', 'allowAllRequests', 'upgradeScheme']);

async function loadList(source) {
  if (source.file) return readFile(path.join(ROOT, source.file), 'utf8');
  const res = await fetch(source.url, { headers: { 'User-Agent': 'ad-interceptor/3.0' } });
  if (!res.ok) throw new Error(`${source.url} -> HTTP ${res.status}`);
  return res.text();
}

/** Split a raw filter list into network rules and cosmetic rules. */
function partition(text) {
  const network = [];
  const cosmetic = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('!') || t.startsWith('[Adblock')) continue;
    (COSMETIC_SEPARATOR.test(t) ? cosmetic : network).push(t);
  }
  return { network, cosmetic };
}

async function toDeclarativeRules(networkRules) {
  const [result] = await new FilterConverter().convert(
    [new Filter(1, networkRules.join('\n'))],
    // Deliberately generous: we want the *whole* conversion so the budgeting
    // below is ours to control, rather than letting the converter truncate
    // arbitrarily at its own limit.
    { combine: true, maxNumberOfRules: 500000, maxNumberOfRegexpRules: 1000 }
  );
  const rules = await result.ruleset.getDeclarativeRules();
  return { rules: rules.filter((r) => SAFE_ACTIONS.has(r.action.type)), errors: result.errors };
}

/**
 * Order rules so that a partially-enabled set is still a *correct* set.
 *
 * Exception rules (allow / allowAllRequests) go first, so they land in chunk 0
 * and are enabled whenever anything is. They exist to undo over-broad block
 * rules, so an exception that is disabled while the block it corrects stays
 * active turns a working site into a broken one — the exact false-positive
 * class that gets an ad blocker uninstalled.
 *
 * Block rules follow in source order (EasyList before EasyPrivacy, and each
 * list runs roughly general-to-specific), so if quota runs out it is the
 * long-tail rules that get dropped rather than the high-traffic ones.
 */
function prioritize(rules) {
  return [
    ...rules.filter((r) => r.action.type !== 'block'),
    ...rules.filter((r) => r.action.type === 'block')
  ];
}

/** Split into chunks, reassigning IDs to be unique within each ruleset. */
function chunk(rules, size) {
  const out = [];
  for (let i = 0; i < rules.length && out.length < MAX_CHUNKS; i += size) {
    out.push(rules.slice(i, i + size).map((rule, j) => ({ ...rule, id: j + 1 })));
  }
  return out;
}

// ---- Cosmetic rules -------------------------------------------------------
/**
 * Parse element-hiding rules into a form cosmetic.js can apply.
 *
 *   ##.selector            -> generic, applies everywhere
 *   a.com,b.com##.selector -> specific, applies on those hostnames
 *   a.com#@#.selector      -> exception, cancels a generic rule on that host
 *
 * Skipped: `#?#`/`#$#` (AdGuard/uBO extended-CSS syntax that is not valid CSS)
 * and `##+js(...)` scriptlet injections (those need a scriptlet runtime, which
 * would mean bundling GPL code - out of scope here).
 */
function parseCosmetic(lines) {
  const generic = new Set();
  const specific = new Map(); // hostname -> Set(selector)
  const exceptions = new Map(); // hostname -> Set(selector)

  for (const line of lines) {
    const m = line.match(/^(.*?)(#@#|##)(.+)$/);
    if (!m) continue; // extended-CSS syntax we don't support
    const [, domainPart, sep, selector] = m;
    if (selector.startsWith('+js(') || selector.includes('{')) continue; // scriptlet / CSS injection

    const domains = domainPart ? domainPart.split(',').map((d) => d.trim()).filter(Boolean) : [];
    // Wildcard TLDs (`ticketmaster.*`) and negated domains (`~a.com`) can't be
    // expressed as a plain hostname key; skip rather than mis-apply them.
    const usable = domains.filter((d) => !d.includes('*') && !d.startsWith('~'));
    if (domains.length && !usable.length) continue;

    if (sep === '#@#') {
      for (const d of usable) {
        if (!exceptions.has(d)) exceptions.set(d, new Set());
        exceptions.get(d).add(selector);
      }
    } else if (!domains.length) {
      generic.add(selector);
    } else {
      for (const d of usable) {
        if (!specific.has(d)) specific.set(d, new Set());
        specific.get(d).add(selector);
      }
    }
  }

  const mapToObject = (map) =>
    Object.fromEntries([...map].map(([k, v]) => [k, [...v]]));

  return {
    generic: [...generic],
    specific: mapToObject(specific),
    exceptions: mapToObject(exceptions),
  };
}

// ---- Main -----------------------------------------------------------------

/** Fetch a tier's lists, convert them, and emit its rulesets + cosmetic data. */
async function buildTier(sources, prefix, enableFirst) {
  const allRules = [];
  const cosmeticLines = [];

  for (const source of sources) {
    process.stdout.write(`Fetching ${source.name}... `);
    const text = await loadList(source);
    const { network, cosmetic } = partition(text);
    cosmeticLines.push(...cosmetic);
    const { rules, errors } = await toDeclarativeRules(network);
    console.log(`${network.length} network / ${cosmetic.length} cosmetic -> ${rules.length} DNR rules (${errors.length} unconvertible)`);
    allRules.push(...rules);
  }

  const chunks = chunk(prioritize(allRules), RULES_PER_CHUNK);
  const rulesets = [];
  for (const [i, rules] of chunks.entries()) {
    const id = `${prefix}-${i + 1}`;
    await writeFile(path.join(ROOT, `rules/${id}.json`), JSON.stringify(rules), 'utf8');
    // Only the free tier's first chunk is enabled in the manifest. Everything
    // else is turned on by background.js — the rest of the free chunks as
    // quota allows, the Pro chunks only for licensed users.
    rulesets.push({ id, enabled: enableFirst && i === 0, path: `rules/${id}.json` });
  }

  const cosmetic = parseCosmetic(cosmeticLines);

  // Generic hiding ships as a plain stylesheet rather than as data the content
  // script has to parse and apply: the browser's own CSS engine is far faster
  // than doing it in JS, and it takes effect before first paint, which is what
  // stops the page flashing an ad-shaped hole before the rule lands.
  // Chunked because one selector list ~13k long is slow to parse in some
  // engines and is unreadable when debugging.
  const CSS_CHUNK = 500;
  const css = [];
  for (let i = 0; i < cosmetic.generic.length; i += CSS_CHUNK) {
    css.push(`${cosmetic.generic.slice(i, i + CSS_CHUNK).join(',\n')} { display: none !important; }`);
  }
  await writeFile(path.join(ROOT, `filters/${prefix}-generic.css`), css.join('\n\n'), 'utf8');

  // generic[] is already baked into the stylesheet above, so it is dropped
  // here to keep the runtime payload small — cosmetic.js only needs the
  // per-domain additions and the exceptions that undo generic rules.
  await writeFile(
    path.join(ROOT, `filters/${prefix}-cosmetic.json`),
    JSON.stringify({ specific: cosmetic.specific, exceptions: cosmetic.exceptions }),
    'utf8'
  );

  return { chunks, rulesets, cosmetic };
}

async function main() {
  await mkdir(path.join(ROOT, 'filters'), { recursive: true });
  await rm(path.join(ROOT, 'rules'), { recursive: true, force: true });
  await mkdir(path.join(ROOT, 'rules'), { recursive: true });

  // EasyList (ads) before EasyPrivacy (trackers): this is an ad blocker, so
  // visible ads outrank invisible trackers if quota ever runs out.
  console.log('\n--- supplemental (ours) ---');
  const custom = await buildTier(CUSTOM_SOURCES, 'custom', true);

  console.log('\n--- free tier ---');
  const free = await buildTier(FREE_SOURCES, 'filters', true);

  console.log('\n--- pro tier ---');
  const pro = await buildTier(PRO_SOURCES, 'pro', false);

  // enableFirst is false for all three Pro tiers: nothing here may be on until
  // background.js has confirmed a licence, and the annoyance tiers additionally
  // wait on the user's own toggle.
  console.log('\n--- pro tier: cookie consent ---');
  const cookies = await buildTier(COOKIE_SOURCES, 'cookies', false);

  console.log('\n--- pro tier: distractions ---');
  const annoy = await buildTier(ANNOY_SOURCES, 'annoy', false);

  // The manifest is generated rather than hand-edited so the ruleset list can
  // never drift out of sync with the files on disk.
  const manifestPath = path.join(ROOT, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // custom first: highest confidence, smallest, must always be enabled.
  // Pro rulesets are BUILT either way (so flipping the flag needs no refetch)
  // but only DECLARED when Pro is on — a manifest that declares a ruleset the
  // package omits makes the extension fail to load, and the dev tree should
  // match the shipped artifact.
  manifest.declarative_net_request = {
    rule_resources: [
      ...custom.rulesets,
      ...free.rulesets,
      // Order is the quota order: syncStaticRulesets() enables declared
      // rulesets in sequence and stops at the first refusal, so the free ad and
      // tracker rules must come before anything Pro adds. Annoyances are worth
      // paying for; they are not worth losing ad blocking to fit.
      ...(PRO_ENABLED ? [...pro.rulesets, ...cookies.rulesets, ...annoy.rulesets] : [])
    ]
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // Publish the counts so nothing has to hardcode them.
  //
  // These numbers move every build — upstream EasyList grows and shrinks.
  // They have already drifted three times (108,233 -> 110,279 -> 106,787),
  // each time leaving a store listing and a pricing page quoting a figure the
  // package no longer contained. The store description even promises they are
  // real build output. So the build writes them down and everything else reads
  // from here.
  const counts = {
    freeNetwork: free.chunks.reduce((n, c) => n + c.length, 0),
    proNetwork: pro.chunks.reduce((n, c) => n + c.length, 0),
    cookieNetwork: cookies.chunks.reduce((n, c) => n + c.length, 0),
    annoyNetwork: annoy.chunks.reduce((n, c) => n + c.length, 0),
    cookieCosmetic: cookies.cosmetic.generic.length + Object.keys(cookies.cosmetic.specific).length,
    annoyCosmetic: annoy.cosmetic.generic.length + Object.keys(annoy.cosmetic.specific).length,
    cosmeticGeneric: free.cosmetic.generic.length,
    cosmeticDomains: Object.keys(free.cosmetic.specific).length,
    builtAt: new Date().toISOString().slice(0, 10)
  };
  await writeFile(
    path.join(ROOT, 'filters/counts.json'),
    `${JSON.stringify(counts, null, 2)}\n`,
    'utf8'
  );
  console.log(`\nWrote filters/counts.json — free ${counts.freeNetwork.toLocaleString('en-US')} network, ${counts.cosmeticGeneric.toLocaleString('en-US')} generic cosmetic`);

  const count = (t) => t.chunks.reduce((n, c) => n + c.length, 0);
  const describe = (label, t) => {
    console.log(`\n${label}`);
    console.log(`  rulesets: ${t.chunks.length} (${t.chunks.map((c) => c.length).join(' + ')}) = ${count(t)} rules`);
    console.log(`  cosmetic: ${t.cosmetic.generic.length} generic, ${Object.keys(t.cosmetic.specific).length} domains, ${Object.keys(t.cosmetic.exceptions).length} exception domains`);
  };
  describe('SUPPLEMENTAL (ours)', custom);
  describe('FREE', free);
  describe('PRO (anti-adblock)', pro);
  describe('PRO (cookie consent)', cookies);
  describe('PRO (distractions)', annoy);
  const total = count(custom) + count(free) + count(pro) + count(cookies) + count(annoy);
  console.log(`\nTotal: ${total} network rules. manifest.json regenerated.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
