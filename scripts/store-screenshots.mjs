#!/usr/bin/env node
/**
 * Build Chrome Web Store listing images.
 *
 * Run:  npm run store
 *
 * Emits into store-listing/screenshots/:
 *   screenshot-N-1280x800.png   (CWS listing screenshots, up to 5)
 *   screenshot-N-640x400.png    (the smaller accepted size, same art)
 *   promo-tile-440x280.png      (small promo tile)
 *
 * Every slide composites the REAL popup renders from design/ — the same PNGs
 * `npm run design` produces from the live popup.html. Nothing here is a mockup,
 * so a listing image can never show a UI the extension doesn't have.
 *
 * The 640x400 variants are the identical page rendered at deviceScaleFactor
 * 0.5 rather than a separate layout, so the two sizes cannot drift apart.
 *
 * CLAIMS: the copy below is generated from real counts passed in by the
 * caller. Keep it that way — a listing that overstates what ships is both a
 * policy problem and the fastest route to one-star reviews.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = path.join(EXT, 'design');
const OUT = path.join(EXT, 'store-listing', 'screenshots');
const CDP = 'http://127.0.0.1:9224';

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataUri = (f) => `data:image/png;base64,${readFileSync(path.join(DESIGN, f)).toString('base64')}`;

// --- real numbers, read from the built artifacts ----------------------------
function shippedCounts() {
  // FREE counts only, from filters/counts.json (written by `npm run build`).
  // This used to sum every ruleset in manifest.json, which in a Pro build
  // silently folds the pro/cookies/annoy rules into "blocking rules" — a
  // number the free product does not have. counts.json is also what the
  // description and the website quote, so the three can no longer disagree.
  const c = JSON.parse(readFileSync(path.join(EXT, 'filters/counts.json'), 'utf8'));
  for (const k of ['freeNetwork', 'cosmeticGeneric', 'cosmeticDomains']) {
    if (!Number.isInteger(c[k])) throw new Error(`filters/counts.json has no ${k} — run npm run build`);
  }
  return { rules: c.freeNetwork, selectors: c.cosmeticGeneric, domains: c.cosmeticDomains };
}

const N = shippedCounts();
const fmt = (n) => n.toLocaleString('en-US');

const SHELL = `
<style>
  @font-face { font-family: system; src: local("-apple-system"); }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1280px; height: 800px; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0B0B0E; color: #F4F4F7;
    display: flex; align-items: center; gap: 72px; padding: 0 96px;
    position: relative;
  }
  /* Accent bloom, echoing the popup's own hero treatment. */
  body::before {
    content: ""; position: absolute; top: -280px; left: -180px;
    width: 900px; height: 900px; pointer-events: none;
    background: radial-gradient(circle, rgba(168,85,247,0.20) 0%, transparent 65%);
  }
  body::after {
    content: ""; position: absolute; right: -220px; bottom: -320px;
    width: 800px; height: 800px; pointer-events: none;
    background: radial-gradient(circle, rgba(99,102,241,0.16) 0%, transparent 65%);
  }
  .copy { position: relative; flex: 1; min-width: 0; }
  h1 {
    font-size: 68px; line-height: 1.04; letter-spacing: -2.6px; font-weight: 700;
  }
  h1 .grad {
    background: linear-gradient(120deg, #A855F7, #6366F1);
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  p { margin-top: 26px; font-size: 25px; line-height: 1.45; color: #9B9BA8; max-width: 30ch; }
  .stats { display: flex; gap: 44px; margin-top: 46px; }
  .stat-n {
    font-size: 40px; font-weight: 700; letter-spacing: -1.2px;
    font-variant-numeric: tabular-nums;
    background: linear-gradient(120deg, #A855F7, #6366F1);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  }
  .stat-l { font-size: 16px; color: #8A8A96; margin-top: 6px; }
  .shot { position: relative; flex-shrink: 0; }
  .shot img {
    width: 412px; border-radius: 20px;
    box-shadow: 0 40px 90px rgba(0,0,0,0.62), 0 0 0 1px rgba(255,255,255,0.07);
  }
  .pair { display: flex; gap: 28px; }
  .pair img { width: 330px; }
  .pair .lightcard { border-radius: 18px; }
  .badges { display: flex; gap: 14px; margin-top: 44px; flex-wrap: wrap; }
  .badge {
    font-size: 17px; padding: 11px 18px; border-radius: 999px;
    background: rgba(255,255,255,0.055); border: 1px solid rgba(255,255,255,0.10);
    color: #D8D8E0;
  }
</style>`;

const SLIDES = [
  {
    name: 'screenshot-1',
    html: `<div class="copy">
      <h1>Every ad.<br><span class="grad">Every site.</span></h1>
      <p>Banner ads, pop-ups, pop-unders and the trackers behind them — stopped before they load.</p>
      <div class="stats">
        <div><div class="stat-n">${fmt(N.rules)}</div><div class="stat-l">blocking rules</div></div>
        <div><div class="stat-n">${fmt(N.selectors)}</div><div class="stat-l">hiding selectors</div></div>
      </div>
    </div>
    <div class="shot"><img src="${dataUri('popup-dark.png')}"></div>`,
  },
  {
    name: 'screenshot-2',
    html: `<div class="copy">
      <h1>Go further<br><span class="grad">with Pro</span></h1>
      <p>Cookie banners, distractions, in-stream video ads and anti-adblock walls — plus an element picker and your own filters. Optional, $14.99 a year.</p>
      <div class="badges">
        <div class="badge">Block an element</div>
        <div class="badge">Custom filters</div>
        <div class="badge">Priority support</div>
      </div>
    </div>
    <!-- Narrower than the other slides: the licensed popup is the tallest
         render, and at 412px wide it would overflow the 800px frame. -->
    <div class="shot"><img style="width:360px" src="${dataUri('popup-pro.png')}"></div>`,
  },
  {
    name: 'screenshot-3',
    html: `<div class="copy">
      <h1>One tap to<br><span class="grad">pause a site</span></h1>
      <p>Aggressive blocking occasionally breaks a page. Pause just that site — your settings everywhere else stay untouched.</p>
      <div class="badges">
        <div class="badge">Per-site pause</div>
        <div class="badge">Instant master switch</div>
      </div>
    </div>
    <div class="shot"><img src="${dataUri('popup-paused.png')}"></div>`,
  },
  {
    name: 'screenshot-4',
    html: `<div class="copy">
      <h1>Your browsing<br><span class="grad">stays yours.</span></h1>
      <p>No analytics. No telemetry. Every rule runs on your machine. The free version never contacts a server; Pro sends only your licence key, to check it is valid.</p>
      <div class="badges">
        <div class="badge">No browsing data</div>
        <div class="badge">No account needed</div>
        <div class="badge">Open filter lists</div>
      </div>
    </div>
    <div class="shot"><img src="${dataUri('popup-dark.png')}"></div>`,
  },
  {
    name: 'screenshot-5',
    html: `<div class="copy">
      <h1>Fits your<br><span class="grad">browser</span></h1>
      <p>Follows your system theme, and covers ${fmt(N.domains)} sites with rules written for those pages specifically.</p>
      <div class="badges">
        <div class="badge">Light &amp; dark</div>
        <div class="badge">Manifest V3</div>
      </div>
    </div>
    <div class="shot pair">
      <img src="${dataUri('popup-dark.png')}">
      <img class="lightcard" src="${dataUri('popup-light.png')}">
    </div>`,
  },
];

// Small promo tile: its own layout — at 440x280 a two-column slide is illegible.
const PROMO = `
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 440px; height: 280px; overflow: hidden; position: relative;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0B0B0E; color: #F4F4F7;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 4px; text-align: center;
  }
  body::before {
    content: ""; position: absolute; top: -140px; left: 50%; transform: translateX(-50%);
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(168,85,247,0.24) 0%, transparent 65%);
  }
  .row { position: relative; display: flex; align-items: center; gap: 12px; }
  svg { width: 40px; height: 40px; }
  .name { font-size: 31px; font-weight: 700; letter-spacing: -1.1px; }
  .tag {
    position: relative; margin-top: 12px; font-size: 15px; color: #9B9BA8;
  }
  .n {
    position: relative; margin-top: 16px; font-size: 15px; font-weight: 600;
    background: linear-gradient(120deg, #A855F7, #6366F1);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  }
</style>
<div class="row">
  <svg viewBox="0 0 32 32" fill="none">
    <defs><linearGradient id="g" x1="0" y1="0" x2="32" y2="32">
      <stop offset="0%" stop-color="#A855F7"/><stop offset="100%" stop-color="#6366F1"/>
    </linearGradient></defs>
    <path d="M16 2.5 4.5 7v9.2c0 6.6 4.7 11.6 11.5 13.3 6.8-1.7 11.5-6.7 11.5-13.3V7L16 2.5Z" fill="url(#g)" opacity="0.18"/>
    <path d="M16 2.5 4.5 7v9.2c0 6.6 4.7 11.6 11.5 13.3 6.8-1.7 11.5-6.7 11.5-13.3V7L16 2.5Z" stroke="url(#g)" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="m11.2 16.2 3.3 3.3 6.3-6.7" stroke="url(#g)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <div class="name">Ad Interceptor</div>
</div>
<div class="tag">Blocks every ad. On every site.</div>
<div class="n">${fmt(N.rules)} blocking rules</div>`;

// ---- CDP -------------------------------------------------------------------
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
    close: () => ws.close(),
  };
}

async function render(html, width, height, scale, outFile) {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  await sleep(250);
  const full = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.id === t.id);
  const c = connect(full.webSocketDebuggerUrl);
  await c.ready;

  await c.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: scale, mobile: false });
  await c.send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
  await sleep(900); // let the embedded PNGs decode and fonts settle

  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(outFile, Buffer.from(shot.result.data, 'base64'));
  c.close();
  await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
}

// ---- main ------------------------------------------------------------------
for (const f of ['popup-dark.png', 'popup-light.png', 'popup-paused.png', 'popup-pro.png']) {
  if (!existsSync(path.join(DESIGN, f))) {
    console.error(`Missing ${f} — run "npm run design" first.`);
    process.exit(1);
  }
}

const browser = BROWSERS.find((b) => existsSync(b));
if (!browser) {
  console.error('No Chromium-based browser found.');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'tab-store-'));
const proc = spawn(browser, [
  '--headless=new', '--remote-debugging-port=9224', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

try {
  for (let i = 0; i < 20; i++) {
    try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(500); }
  }

  console.log(`Shipped counts: ${fmt(N.rules)} rules, ${fmt(N.selectors)} selectors, ${fmt(N.domains)} domains\n`);

  for (const s of SLIDES) {
    const html = SHELL + s.html;
    await render(html, 1280, 800, 1, path.join(OUT, `${s.name}-1280x800.png`));
    console.log(`  ${s.name}-1280x800.png`);
    // Same page at half scale — the two sizes cannot drift apart.
    await render(html, 1280, 800, 0.5, path.join(OUT, `${s.name}-640x400.png`));
    console.log(`  ${s.name}-640x400.png`);
  }

  await render(PROMO, 440, 280, 1, path.join(OUT, 'promo-tile-440x280.png'));
  console.log('  promo-tile-440x280.png');

  console.log(`\nWrote ${SLIDES.length * 2 + 1} images to store-listing/screenshots/`);
} finally {
  proc.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
