#!/usr/bin/env node
/**
 * Publish a freshly-built Pro filter set to the licence API.
 *
 * Usage:
 *   API_BASE=https://... ADMIN_TOKEN=... node scripts/publish-pro-filters.mjs [--build]
 *
 * WHY THIS IS A SCRIPT AND NOT A CRON WORKER
 * The obvious design is a scheduled Worker that fetches the filter lists and
 * converts them itself. That means bundling @adguard/tsurlfilter into the
 * Worker, which is both large enough to be awkward against the bundle limit
 * and CPU-hungry enough to be uncomfortable inside a cron invocation. Worse,
 * it would be a SECOND implementation of a conversion that scripts/
 * build-filters.mjs already does correctly and that npm test covers.
 *
 * So the split is: convert here, with the code that is already trusted, and
 * let the Worker do nothing but authenticate and serve. Run this from cron or
 * a GitHub Action; the Pro promise is "daily", so daily is enough.
 */
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const API_BASE = process.env.API_BASE?.replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!API_BASE || !ADMIN_TOKEN) {
  console.error('Set API_BASE and ADMIN_TOKEN.\n');
  console.error('  API_BASE=https://ad-interceptor-api.<sub>.workers.dev \\');
  console.error('  ADMIN_TOKEN=<the secret you set with `wrangler secret put ADMIN_TOKEN`> \\');
  console.error('  node scripts/publish-pro-filters.mjs --build');
  process.exit(2);
}

// --build regenerates rules/ from upstream first. Without it we publish
// whatever the last local build produced, which is right for a retry after a
// failed upload and wrong for a scheduled run.
if (process.argv.includes('--build')) {
  console.log('Rebuilding filters from upstream...\n');
  const r = spawnSync('node', [path.join(ROOT, 'scripts/build-filters.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('\nBuild failed — not publishing. The previously published set stays live.');
    process.exit(1);
  }
}

// build-filters.mjs chunks Pro output across pro-1.json, pro-2.json, ... The
// API serves one flat array, so recombine in numeric (not lexical) order —
// pro-10 must not sort before pro-2.
const proFiles = readdirSync(path.join(ROOT, 'rules'))
  .filter((f) => /^pro-\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

if (!proFiles.length) {
  console.error('No rules/pro-*.json found. Run with --build, or check PRO_SOURCES in build-filters.mjs.');
  process.exit(1);
}

const rules = [];
for (const f of proFiles) {
  const chunk = JSON.parse(await readFile(path.join(ROOT, 'rules', f), 'utf8'));
  rules.push(...chunk);
  console.log(`  ${f}: ${chunk.length} rules`);
}

// Rule ids are only unique within a chunk in the packaged build, because each
// static ruleset gets its own id space. Flattened into one dynamic set they
// collide, and Chrome rejects the whole batch on a duplicate id — so renumber.
rules.forEach((rule, i) => { rule.id = i + 1; });

console.log(`\nPublishing ${rules.length} rules to ${API_BASE} ...`);

const res = await fetch(`${API_BASE}/v1/admin/filters`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    // Cloudflare's bot protection 403s requests with a bare or missing
    // user-agent, which is what Node's fetch sends by default. Discovered the
    // hard way: every call from a script was rejected before reaching the
    // Worker, with a 403 that looks exactly like an auth failure.
    'User-Agent': 'ad-interceptor-filter-publisher/1.0'
  },
  body: JSON.stringify({ rules, builtAt: Date.now() })
});

const text = await res.text();
if (!res.ok) {
  console.error(`Publish failed: ${res.status} ${text}`);
  process.exit(1);
}
console.log(`Published: ${text}`);
