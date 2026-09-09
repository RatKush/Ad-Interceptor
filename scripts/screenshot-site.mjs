#!/usr/bin/env node
/**
 * Screenshot the live site at desktop and mobile width, and MEASURE it.
 *
 * Run:  node scripts/screenshot-site.mjs [origin]
 *
 * Written after shipping two layout bugs that reading the CSS did not reveal:
 * a `grid-row: 1 / span 99` that created 99 grid rows and, with a 48px gap,
 * about 4,700px of blank space per section. The page looked fine in source and
 * was unusable in a browser.
 *
 * So this does two things reading cannot: it writes PNGs to look at, and it
 * reports the largest vertical gap between consecutive blocks. A page with a
 * gap larger than a viewport is broken, whatever the CSS says.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'design/site');
const CDP = 'http://127.0.0.1:9224';
const ORIGIN = process.argv[2] ?? 'https://ad-interceptor.pages.dev';

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const PAGES = ['/', '/pricing', '/terms'];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 420, height: 900 }
];

// Anything taller than a viewport of empty space between two blocks is a bug.
const MAX_GAP = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return {
    ready,
    send(method, params = {}) {
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params }));
      return new Promise((r) => pending.set(msgId, r));
    },
    close: () => ws.close()
  };
}

// Walks the top-level blocks in document order and reports the biggest
// vertical hole between one ending and the next beginning.
const MEASURE = `(() => {
  const blocks = [...document.querySelectorAll('main > *, main section > *')]
    .filter((el) => el.getClientRects().length)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), top: r.top + scrollY, bottom: r.bottom + scrollY };
    })
    .sort((a, b) => a.top - b.top);

  let worst = { gap: 0, after: null };
  for (let i = 1; i < blocks.length; i++) {
    const gap = blocks[i].top - blocks[i - 1].bottom;
    if (gap > worst.gap) worst = { gap: Math.round(gap), after: blocks[i - 1].tag };
  }
  return JSON.stringify({
    scrollHeight: document.documentElement.scrollHeight,
    blocks: blocks.length,
    worstGap: worst.gap,
    worstAfter: worst.after,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
  });
})()`;

const browser = BROWSERS.find((b) => existsSync(b));
if (!browser) { console.error('No Chrome/Edge/Chromium found.'); process.exit(1); }

await mkdir(OUT, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'ai-site-'));
const proc = spawn(browser, [
  '--headless=new', '--remote-debugging-port=9224',
  `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
  '--force-color-profile=srgb', 'about:blank'
], { stdio: 'ignore' });

async function cleanup() {
  proc.kill();
  // Chrome keeps writing to its profile for a moment after SIGTERM, so an
  // immediate rmdir races it and throws ENOTEMPTY. Give it a beat, and never
  // let tidy-up failure mask the result we came for.
  await sleep(600);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

let failures = 0;
try {
  for (let i = 0; i < 40; i++) {
    try { await (await fetch(`${CDP}/json/version`)).json(); break; } catch { await sleep(300); }
  }

  console.log(`Screenshotting ${ORIGIN}\n`);
  console.log(`  ${'page'.padEnd(17)}${'viewport'.padEnd(10)}${'height'.padStart(8)}${'blocks'.padStart(8)}${'worst gap'.padStart(11)}`);
  console.log('  ' + '-'.repeat(60));

  for (const pg of PAGES) {
    for (const vp of VIEWPORTS) {
      const tab = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
      const c = connect(tab.webSocketDebuggerUrl);
      await c.ready;
      await c.send('Page.enable');
      await c.send('Emulation.setDeviceMetricsOverride',
        { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false });
      // Bypass the HTTP cache entirely. Cache-busting only the document still
      // let a stale site.css through, which made a fresh deploy measure
      // identical to the previous one and looked like the change had no effect.
      await c.send('Network.enable');
      await c.send('Network.setCacheDisabled', { cacheDisabled: true });
      await c.send('Page.navigate', { url: ORIGIN + pg + '?cb=' + Date.now() });
      await sleep(2600); // let PricePreview and fonts settle

      const res = await c.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
      const m = JSON.parse(res.result?.result?.value ?? '{}');

      const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const name = `${(pg === '/' ? 'home' : pg.slice(1))}-${vp.name}.png`;
      await writeFile(path.join(OUT, name), Buffer.from(shot.result.data, 'base64'));

      const bad = m.worstGap > MAX_GAP || m.overflowX;
      if (bad) failures++;
      console.log(
        `  ${pg.padEnd(17)}${vp.name.padEnd(10)}${String(m.scrollHeight).padStart(8)}${String(m.blocks).padStart(8)}${String(m.worstGap).padStart(11)}`
        + (m.worstGap > MAX_GAP ? `  <-- ${m.worstGap}px hole after <${m.worstAfter}>` : '')
        + (m.overflowX ? '  <-- horizontal overflow' : '')
      );

      c.close();
      await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
    }
  }
} finally {
  await cleanup();
}

console.log(`\nPNGs in design/site/`);
if (failures) {
  console.error(`${failures} viewport(s) show a layout hole over ${MAX_GAP}px or horizontal overflow.`);
  process.exit(1);
}
console.log('No oversized gaps, no horizontal overflow.');
