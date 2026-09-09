#!/usr/bin/env node
/**
 * Assert a staged package's localisation is complete and within Chrome's limits.
 *
 * Usage: node scripts/check-locales.mjs <stage-dir>
 *
 * The failure this exists to prevent is loud and public: a manifest that uses
 * __MSG_extName__ with a missing or incomplete catalogue either fails to load,
 * or ships with the literal text "__MSG_extName__" as the extension's name on
 * the Chrome Web Store. Store search is per-locale and the name is the
 * heaviest-weighted field, so a silently broken locale is a locale that does
 * not exist as far as discovery is concerned.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const stage = process.argv[2];
if (!stage) {
  console.error('usage: check-locales.mjs <stage-dir>');
  process.exit(2);
}

const NAME_MAX = 75;   // Chrome's documented limit for manifest "name"
const DESC_MAX = 132;  // store short-description limit

const manifest = JSON.parse(readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
const localesDir = path.join(stage, '_locales');
const problems = [];

// Which message keys does the manifest actually reference?
const referenced = [...new Set(
  JSON.stringify(manifest).match(/__MSG_(\w+)__/g)?.map((m) => m.slice(6, -2)) ?? []
)];

if (!referenced.length) {
  console.log('No __MSG_*__ placeholders in the manifest — nothing to check.');
  process.exit(0);
}

if (!manifest.default_locale) {
  problems.push('manifest uses __MSG_*__ but has no "default_locale" — Chrome refuses to load this');
}
if (!existsSync(localesDir)) {
  console.error('AUDIT FAILED:\n  _locales/ is missing from the package entirely');
  process.exit(1);
}

const locales = readdirSync(localesDir).filter((f) => !f.startsWith('.'));

if (manifest.default_locale && !locales.includes(manifest.default_locale)) {
  problems.push(`default_locale "${manifest.default_locale}" has no _locales/ entry`);
}

for (const loc of locales) {
  const file = path.join(localesDir, loc, 'messages.json');
  if (!existsSync(file)) {
    problems.push(`${loc}: no messages.json`);
    continue;
  }

  let messages;
  try {
    messages = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push(`${loc}: messages.json is not valid JSON (${e.message})`);
    continue;
  }

  for (const key of referenced) {
    const entry = messages[key];
    if (!entry || typeof entry.message !== 'string' || !entry.message.trim()) {
      problems.push(`${loc}: missing or empty "${key}"`);
      continue;
    }
    // A translation that still contains a placeholder means a broken pipeline.
    if (/__MSG_/.test(entry.message)) {
      problems.push(`${loc}: "${key}" still contains a __MSG_*__ placeholder`);
    }
  }

  const name = messages.extName?.message ?? '';
  if (name.length > NAME_MAX) {
    problems.push(`${loc}: extName is ${name.length} chars, over Chrome's ${NAME_MAX} limit`);
  }
  const desc = messages.extDescription?.message ?? '';
  if (desc.length > DESC_MAX) {
    problems.push(`${loc}: extDescription is ${desc.length} chars, over the ${DESC_MAX} limit`);
  }
}

if (problems.length) {
  console.error('LOCALE CHECK FAILED:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`Locale check passed: ${locales.length} locales, keys [${referenced.join(', ')}] complete.`);
