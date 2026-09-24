#!/usr/bin/env node
// Turns main-frame-only BLOCK rules into REDIRECTS to blocked.html.
//
// A blocked main-frame navigation leaves the tab on Chrome's blank
// "blocked by an extension" page. For pop-ups and pop-unders — which is what
// almost every main-frame rule in EasyList is for — that means the ad tab
// still opens, just empty, and reads as "the pop-up blocker didn't work".
// Redirecting to a packaged page lets it close itself (see blocked.js).
//
// Only rules whose resourceTypes are exactly ["main_frame"] and whose action is
// "block" change. Mixed-type rules and allow rules are left alone, so ids,
// counts and priorities are untouched.
//
// Used by build-filters.mjs on every build; run directly to convert the rule
// files already on disk:  node scripts/popup-redirect.mjs
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BLOCKED_PAGE = '/blocked.html';

export function redirectMainFrameBlocks(rules) {
  let changed = 0;
  const out = rules.map((rule) => {
    const types = rule.condition && rule.condition.resourceTypes;
    if (rule.action?.type !== 'block' || !Array.isArray(types) || types.length !== 1 || types[0] !== 'main_frame') {
      return rule;
    }
    changed++;
    return { ...rule, action: { type: 'redirect', redirect: { extensionPath: BLOCKED_PAGE } } };
  });
  return { rules: out, changed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rules');
  let total = 0;
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json'))) {
    const p = path.join(dir, file);
    const { rules, changed } = redirectMainFrameBlocks(JSON.parse(await readFile(p, 'utf8')));
    if (changed) {
      await writeFile(p, JSON.stringify(rules), 'utf8');
      console.log(`${file}: ${changed} main-frame block rule(s) -> redirect`);
      total += changed;
    }
  }
  console.log(`done, ${total} rule(s) converted`);
}
