#!/usr/bin/env node
/**
 * Render the real popup in headless Chromium and write design/*.png.
 *
 * Run:  npm run design
 *
 * These are screenshots of the actual popup.html, not mockups, which is the
 * point: reviewing the rendered result caught two bugs that reading the CSS
 * did not — row titles collapsing onto one line, and the Pro licence form
 * staying visible because an author `display` rule outranks `[hidden]`.
 *
 * The popup normally reads live data. Opened standalone there is no real tab
 * to report on, so each state below seeds plausible display values and then
 * drives the popup's OWN render() so the screenshot reflects real behaviour
 * rather than hand-set classes.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PRO_ENABLED } from '../config.js';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(EXT, 'design');
const CDP = 'http://127.0.0.1:9223';

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome derives an unpacked extension's id from the SHA-256 of its path. */
function extensionId(absPath) {
  const hex = createHash('sha256').update(absPath).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

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

// Shared display values, so every shot shows the same site and totals.
const SEED = `
  document.getElementById('statPage').textContent = '47';
  document.getElementById('statTotal').textContent = '12,843';
  document.getElementById('siteHost').textContent = 'theguardian.com';
  state.hasSite = true;
  state.hostname = 'theguardian.com';
`;

const STATES = [
  { name: 'popup-dark', scheme: 'dark', js: `${SEED} render();` },
  { name: 'popup-light', scheme: 'light', js: `${SEED} render();` },
  {
    name: 'popup-pro',
    scheme: 'dark',
    proOnly: true,
    js: `${SEED}
      document.getElementById('proBadge').textContent = 'Active';
      document.getElementById('proBadge').classList.add('active');
      document.getElementById('proForm').hidden = true;
      document.getElementById('removeBtn').hidden = false;
      document.getElementById('proControls').hidden = false;
      // Mirror what renderPro() does for an active licence: the sales list
      // folds away and the summary line replaces it. Set directly rather than
      // calling renderPro, which would need a live licence:status round trip —
      // but it must be kept in step, or this shot documents a UI that no
      // licensed user ever sees.
      document.getElementById('proCard').classList.add('is-active');
      document.getElementById('proFold').classList.add('no-anim', 'is-folded');
      document.getElementById('proSummary').setAttribute('aria-expanded', 'false');
      document.getElementById('proSummaryText').textContent =
        'All ' + document.querySelectorAll('#proFeatures li').length + ' Pro features active';
      render();`,
  },
  {
    name: 'popup-off',
    scheme: 'dark',
    js: `${SEED}
      document.getElementById('statPage').textContent = '0';
      document.getElementById('adsToggle').checked = false;
      state.enabled = false;
      render();`,
  },
  {
    name: 'popup-paused',
    scheme: 'dark',
    js: `${SEED} state.paused = true; render();`,
  },
];

// In a free build the Pro card is hidden, so the "pro" shot would render as a
// byte-identical copy of popup-dark — a file named popup-pro.png showing no
// Pro is more misleading than no file at all.
const states = STATES.filter((st) => PRO_ENABLED || !st.proOnly);
if (!PRO_ENABLED) {
  await rm(path.join(OUT, 'popup-pro.png'), { force: true });
}

const browser = BROWSERS.find((b) => existsSync(b));
if (!browser) {
  console.error('No Chromium-based browser found.');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'tab-design-'));
const proc = spawn(browser, [
  '--headless=new', '--remote-debugging-port=9223', `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank',
], { stdio: 'ignore' });

try {
  for (let i = 0; i < 20; i++) {
    try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(500); }
  }
  const url = `chrome-extension://${extensionId(EXT)}/popup.html`;

  for (const { name, scheme, js } of states) {
    const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    await sleep(900);
    const full = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.id === t.id);
    const c = connect(full.webSocketDebuggerUrl);
    await c.ready;

    await c.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await c.send('Runtime.evaluate', { expression: js, awaitPromise: true });
    // Long enough for the async license:status round-trip to land and hide the
    // Pro card in free builds — measuring before that leaves dead space below
    // the last card in the capture.
    await sleep(1200);

    // Size the viewport to the content so nothing is cropped or padded.
    // Measured from the DOM, not Page.getLayoutMetrics: cssContentSize keeps
    // reporting the pre-hide height after the Pro card is removed, which left
    // ~130px of dead space under the last card.
    const measured = await c.send('Runtime.evaluate', {
      expression: 'Math.ceil(document.documentElement.getBoundingClientRect().height)',
      returnByValue: true,
    });
    const height = measured.result?.result?.value || 520;
    await c.send('Emulation.setDeviceMetricsOverride',
      { width: 340, height, deviceScaleFactor: 2, mobile: false });
    await sleep(200);

    const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join(OUT, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
    console.log(`  ${name}.png  340x${height} @2x`);

    c.close();
    await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
  }
  console.log(`\nWrote ${states.length} screenshots to design/ (PRO_ENABLED=${PRO_ENABLED})`);
} finally {
  proc.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
