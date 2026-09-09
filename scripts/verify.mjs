#!/usr/bin/env node
/**
 * Integration test: load the real extension into a real Chromium and check
 * that it actually blocks things.
 *
 * Run:  npm run verify
 *
 * This exists because the unit tests cannot see the class of bug that matters
 * most here. The extension is mostly *configuration of browser APIs*, and those
 * fail at runtime, silently, in ways no amount of static checking reveals — the
 * first run of this script found that unregisterContentScripts() rejects the
 * whole call if any id is not currently registered, which had silently broken
 * per-site pause and Pro activation for every user.
 *
 * Run it before every release.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PRO_ENABLED } from '../config.js';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8899;
const CDP = 'http://127.0.0.1:9222';

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

// The ad requests fire during page load, not on demand from report(). That
// matters: the badge counter samples at the tab's `complete` event, so
// requests issued later by the test would be attributed to no page load at
// all — and it is also simply what a real ad-bearing page does.
const TEST_PAGE = `<!doctype html><html><head><title>t</title></head><body>
<div id="AC_ad">bait</div><div id="control-element">control</div>
<script>
async function tryFetch(u){try{await fetch(u,{mode:'no-cors',cache:'no-store'});return 'loaded'}catch(e){return 'blocked'}}
const probes = {
  ad: tryFetch('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'),
  ad2: tryFetch('https://securepubads.g.doubleclick.net/tag/js/gpt.js'),
  benign: tryFetch('https://example.com/'),
  // Regression: reported live on www.catforum.com (2026-08-29). Randomised
  // subdomain + path proxy that EasyList only blocks for popups. Covered by
  // filters/custom.txt — see the note there.
  reported: tryFetch('https://6.stg.html-load.com/session/8py/03c/t3v/www.catforum.com/tyo/qwhvi331tyxywywqy77yrxzvti3vzbf7cyrqsjyw9k6yfwoywo9okww9ywfjvcntywfjcy09yr17cynvtyin43gvycyzyky2yz99qs7xfcy37y7n4yz99yzkymwyzykyl'),
  // Third report (cookieandkate.com): a bare '8.' subdomain rather than
  // '*.stg.'. Path shape kept, query trimmed — the rule under test is the
  // domain match ||html-load.com^, which covers every subdomain.
  reported3: tryFetch('https://8.html-load.com/session/ny4/u4q/fv0/z9f/cookieandkate.com/otg/probe.png'),
  reported2: tryFetch('https://9.stg.html-load.com/session/gsw/1cc/cnb/2jj/www.catforum.com/otg/qwhvi331tyxywywvy7qzfqbyrcyry7s5mznqzfqbyr7n3ywvqzbyntvyczyevfycyoypy4yffqpvoy8vgyoyuy3qlyujtypy1sy0ytylsymyhggyymtfymyspvjyhpapvl4vi1lurwy2wy9ymy8yle9ttpvpvytpayocy3yobyl8ymy2uy5yo99y4yay3ymy9j1ymsy92yvpayv6cwpvyi6ymy3ym8ymypy20ymy1yyy2yhsy45ymyvy1wy2bty1cy1y4y4yoyov6ymv8sygy0psy3n0ysy63ipvyom26pvgygy9ylpsympa0j96yfsewpsry8yukmyvay2yty5pvyh1ly8y7yujy0q4iyyyppaoy3y7u1y6yiipympap3y32y1exy2ylygyog9fopa8kyvpsry2ytyvyfyhz7zmgy5psyavyhygqpyy0yuytpsyuy9y5ylyhytyhkmby4y00ygnzqwy0y1z6ykpay6iytykstyv7pven1yf8wy2c7j0yupv8cy9yty52y7yvxyoymy6yh9y0ty3my4gcymp3y2ypytlytbyulyhy8tp3y1y4yy8q7y6yheyiuytyhl4yhyukwgvgqy4iy2y7ny5ypgjyppsylpvy8yvy7zop6bpsyuympycbgy883y8cy9yp21fn6pyygpsey9qp67ypyay52rtyavuekrps7y7uy2uy2yyp3u5mryamyvp6vp3yyyuyayyy4y14y2p6y5mmykipyjyjlyuymunyay9yfy5c1y6kny7yhy4xiyac10y9irp3yfo8tpybapymp3p6g01ki5mygbytc9nkpvyiqpvy3yowqyhvmip6ubru90y7y0pvy60y3pyyj3ylygy45ttyf9ykymy2y5payyyfmyliy2nymy4ympvcyj1y5jitpy7ymy2y9psoy2y9pvy3yvyuymy2ysymyocy2foymy260y3iykcq8ymn7ryyy4yo8ymnjli5sy2yfrytty9yhsy2y0y1yuysocyaz3cm8ymn8jyky4yo8ymxyioyyy4yo8ymnytri5sy22y1pvysocyayfytymm8ymx5zgy4yo8ymxyi7gy4yo8ymnllgy4yo8ymnx6my4yo8ymnjoyky4yo8ymxp63gy4yo8ymnvy28cyay02o4ym8cyak2yi4ym8cyayiypyh4ym3cyaymypymy3ymy7y3y3ypcfympvyuymy2ysy2w0yoy38yocy3yoymcy3ymy3ytcyiymy9y3ylymcy3yoymcyhfymym8fylcy2y2y3lxky2ytzupyes0agyppapaym9ymy2cymsylbymtyljymty20ymty2cymay2scayoy8ymys8yly9yvyvygtcy5ymny3y5y4auyt9pv9agyppapaym4psyy8yspvyoyavy12ymyoyg8ylyuypy3jp6y8y1tyhryjzcyppy0oijymi9uyiy9ymbyfymwyofymyky0y0y0y0y0y0y0y0y0y0y0yfy2tymyky6jy6oyaysnymy8j6ygy4typrv6yk6q9y2ypyywy2p3y2yfy2psv3y5y8y1yjxspyyvky5smky21p67zxpaz1xytylc0y5up3ry5uyp2y5ylb0ytpyyfwy5uy3kytylbeypygy99ytygy3rypyfspaymcsymyiy2pvy2cy2qy2tiqy9ysymy48youbky5rp36ypygy3wy5yly5y9y2gspsymucy28icpsyoy9ymymymymyoy9ly1yjymy4cs2y5rqeytyly40y5yly9rysymys0ysymby8ym8eyuysyo6fymy9yly9ysymyayoysy9y3y3ymy9yevnyceyecqzfy7ycy4ymy3vy3y9smyoiypy3yfy39y9tyhryjzcyppy0oijymi9uyiy9ymby4ymy4pvymy8ymy2y4cyhnsy0yly0y2ay4ye75jyceyeqfy7ycyoymy9y87ay3ymy9yp6ikyoeysbfy1ivy5y10v71bty4yp7qyy9ylfyoykcxc1vyawy2kkpap35yyyy8pay9payfxykyay8ymykp6ygygxps92y4ypp371yopvjpyyulyyy2ykymiyvbymkyagyupyzpvypyty3zf6y7y3yussyiyuy79ey9yif5yvy2yuyuy1fyley77pvy9u7er4jyjcwyyfyvy2ymymyl7ekpvky47yty66je1yspacjylsyfkyly3mpsyuygygp69yky7aykpspsy1y6ly4ngytztyg4parygeey8y4y7y6nyyuy8p3y28y40oytlbygyuomrmwfy1kyjzqcy1yo7ykwyyqy43y1y0yyy6y4v0lyylyleryaygymy0girkyfkwyhcypy2y571payvymoqy3y5c9ik9p6ysymygyyy1fl2y2yva056yhy1yo2y0y6mymzpsygjy5w0p3zy7y9ysy9y7sgs9yhy42yp3yay3y06cwy4wj711ue9erypykyafny9p6naytkrwy8ylygfvyjkrpsy5jy5y4ymy6pvp3uy4pypanygylylytp682yty7yoicy2yetfcycymytylo6y09y3yl11faypy5y6ab0w92y0p3p3y991zpayayuy4y9yeq301nyc2yeqzfn73ycqvyi15myiyk9wow9e226yky6kw6yfye7mycy6yevy75gzyci331tyxywyw7nmsgvt35y7fsyrqsjyw1gsy75q3tywbv7tsyizslntnv3yi9yitnv3ngyiqs10yzkyjlvgfv73yzkyl6o9ykyfy62e6oy69kkyz9oqs573g0yzkyly3y5yz9oq5ggn7q0yzkyly3y5yuyz9o53jy0jny7f5jyzkyl1gsy75q3y0t07qyz9o53jy0ts5gqnyzkylcsscznyz9o53jy0qs73n73yzkyltvcy0sgcv7fqyz9o53jy0qvj1vfc7yzkyltvcy0sgcv7fqyz9o53jy0ts5gqnyzkylcsscznyz9o53jy0jny7f5jyzkylq1qyz9o53jy0qvj1vfc7yzkylysssczny0paymyoy0y8vznty0y1ypv4y0yj5g7f35gny0w9yvp3yypv9w9oyz9o53jy03ngjyzkylyz9o53jy0qs73n73yzkylyz9ocvy7y0ts5gqnyzkyl2yz9ocvy7y0qvj1vfc7fy7yzkyl9ky6y66woyfek9yz9ocqzfy7yzkyly4ymy3vy3y9smyoiypy3yfy39y9tyhryjzcyppy0oijymi9uyiy9ymby4ymy4pvymy8ymy2y4cyhnsy0yly0y2ay4yevtyin43gvycyzyky2yz99qs7xfcy37y7n4yz99yzkymwyzykyl'),
};
window.report=async()=>({
  bait: getComputedStyle(document.getElementById('AC_ad')).display,
  control: getComputedStyle(document.getElementById('control-element')).display,
  ad: await probes.ad,
  benign: await probes.benign,
  reported: await probes.reported,
  reported2: await probes.reported2,
  reported3: await probes.reported3,
  flag: String(window.blockAdBlock),
});
</script></body></html>`;

// ---- tiny CDP client ------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpList() {
  return (await fetch(`${CDP}/json/list`)).json();
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
    async eval(expression) {
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true } }));
      const m = await new Promise((r) => pending.set(msgId, r));
      return m.result?.result?.value;
    },
    close: () => ws.close(),
  };
}

async function newPage(url) {
  return (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
}

/** MV3 workers idle out after ~30s; opening the popup sends a message and wakes it. */
async function serviceWorker(extId) {
  for (let i = 0; i < 15; i++) {
    const t = (await cdpList()).find((x) => x.type === 'service_worker' && x.url.includes(extId));
    if (t) { const c = connect(t.webSocketDebuggerUrl); await c.ready; return c; }
    const p = await newPage(`chrome-extension://${extId}/popup.html`);
    await sleep(800);
    await fetch(`${CDP}/json/close/${p.id}`).catch(() => {});
  }
  throw new Error('service worker would not start');
}

/**
 * Chrome derives an unpacked extension's ID from the SHA-256 of its absolute
 * load path: first 16 bytes, hex, each nibble mapped 0-f -> a-p.
 *
 * Computing it beats scanning CDP targets for a service worker, because an
 * MV3 worker that has idled out has no target to find — the scan was racing
 * the worker's ~30s shutdown and failing intermittently.
 */
function extensionId(absPath) {
  const hex = createHash('sha256').update(absPath).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// ---- assertions -----------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
  cond ? pass++ : fail++;
}

async function probePage() {
  const t = await newPage(`http://localhost:${PORT}/`);
  await sleep(2200);
  const full = (await cdpList()).find((x) => x.id === t.id);
  const c = connect(full.webSocketDebuggerUrl);
  await c.ready;
  const v = await c.eval('window.report()');
  c.close();
  await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
  return v;
}

// ---- main -----------------------------------------------------------------
const browser = BROWSERS.find((b) => existsSync(b));
if (!browser) {
  console.error('No Chromium-based browser found. Tried:\n' + BROWSERS.map((b) => `  ${b}`).join('\n'));
  process.exit(1);
}

const server = createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(TEST_PAGE);
}).listen(PORT);

const profile = await mkdtemp(path.join(tmpdir(), 'tab-verify-'));
const proc = spawn(browser, [
  '--headless=new', '--remote-debugging-port=9222', `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank',
], { stdio: 'ignore' });

async function cleanup() {
  proc.kill();
  server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

try {
  console.log(`\nBrowser: ${path.basename(browser)}`);
  for (let i = 0; i < 20; i++) {
    try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(500); }
  }

  const extId = extensionId(EXT);
  console.log(`Extension: ${extId}`);
  const sw = await serviceWorker(extId);
  await sw.eval('chrome.storage.sync.set({ads:true, allowlist:[]})');
  await sleep(1500);

  console.log('\nRule loading');
  const rulesets = await sw.eval('chrome.declarativeNetRequest.getEnabledRulesets()');
  const declared = await sw.eval(
    'chrome.runtime.getManifest().declarative_net_request.rule_resources.map(r=>r.id)');
  const freeIds = declared.filter((id) => !id.startsWith('pro-'));
  check(`all ${freeIds.length} free rulesets enabled`,
    freeIds.every((id) => rulesets.includes(id)), JSON.stringify(rulesets));
  check('Pro rulesets NOT enabled without a licence',
    !rulesets.some((id) => id.startsWith('pro-')), JSON.stringify(rulesets));
  const scripts = await sw.eval('chrome.scripting.getRegisteredContentScripts().then(s=>s.map(x=>x.id))');
  check('cosmetic content script registered', scripts.includes('tab-cosmetic'), JSON.stringify(scripts));

  console.log('\nBlocking (free tier)');
  let v = await probePage();
  check('ad script blocked', v.ad === 'blocked', v.ad);
  check('benign request allowed', v.benign === 'loaded', v.benign);
  check('ad-shaped element hidden', v.bait === 'none', v.bait);
  check('control element untouched', v.control === 'block', v.control);
  check('reported html-load.com ad blocked (6.stg)', v.reported === 'blocked', v.reported);
  check('reported html-load.com ad blocked (9.stg)', v.reported2 === 'blocked', v.reported2);
  check('reported html-load.com ad blocked (bare 8.)', v.reported3 === 'blocked', v.reported3);

  console.log('\nBlocked counter');
  // Fresh page load so the counter has a clean baseline to attribute to.
  const t = await newPage(`http://localhost:${PORT}/`);
  await sleep(1000);
  const pf = (await cdpList()).find((x) => x.id === t.id);
  const pc = connect(pf.webSocketDebuggerUrl);
  await pc.ready;
  await pc.eval('window.report()');
  await sleep(3500);
  const matched = await sw.eval(
    'chrome.declarativeNetRequest.getMatchedRules({}).then(x=>x.rulesMatchedInfo.length).catch(e=>-1)');
  check('getMatchedRules reports blocks', matched > 0, `got ${matched}`);
  const stats = await sw.eval(`(async () => {
    const t = (await chrome.storage.local.get('blockedTotal')).blockedTotal || 0;
    return t;
  })()`);
  check('lifetime total accumulated', stats > 0, `got ${stats}`);
  pc.close();
  await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});

  console.log('\nMaster switch');
  await sw.eval('chrome.storage.sync.set({ads:false})');
  await sleep(1500);
  const dyn = await sw.eval('chrome.declarativeNetRequest.getDynamicRules().then(r=>r.map(x=>x.id))');
  check('master-off override rule added', dyn.includes(1), JSON.stringify(dyn));
  const off = await sw.eval('chrome.scripting.getRegisteredContentScripts().then(s=>s.length)');
  check('content scripts removed when off', off === 0, `${off} still registered`);
  await sw.eval('chrome.storage.sync.set({ads:true})');
  await sleep(1500);

  console.log('\nPer-site pause');
  await sw.eval('chrome.storage.sync.set({allowlist:["localhost"]})');
  await sleep(1800);
  v = await probePage();
  check('ads load while paused', v.ad === 'loaded', v.ad);
  check('cosmetic off while paused', v.bait !== 'none', v.bait);
  await sw.eval('chrome.storage.sync.set({allowlist:[]})');
  await sleep(1800);
  v = await probePage();
  check('blocking resumes after unpause', v.ad === 'blocked', v.ad);

  if (!PRO_ENABLED) {
    // Free build: assert Pro is genuinely absent, not merely hidden. This is
    // the claim the store listing's "collects nothing" disclosure rests on.
    console.log('\nPro compiled out (PRO_ENABLED=false)');
    const declaredIds = await sw.eval(
      'chrome.runtime.getManifest().declarative_net_request.rule_resources.map(r=>r.id)');
    check('no pro-* rulesets declared in manifest',
      !declaredIds.some((id) => id.startsWith('pro-')), JSON.stringify(declaredIds));

    // Even with a valid-looking licence written directly to storage, nothing
    // Pro may activate — the code is not in the package to activate.
    await sw.eval(`chrome.storage.local.set({license:{key:'TEST',plan:'pro',expiresAt:Date.now()+864e5,lastCheck:Date.now(),lastGoodCheck:Date.now()}})`);
    await sleep(1800);
    const scriptsAfter = await sw.eval(
      'chrome.scripting.getRegisteredContentScripts().then(s=>s.map(x=>x.id))');
    check('a forged licence cannot enable Pro scripts',
      !scriptsAfter.includes('tab-scriptlets') && !scriptsAfter.includes('tab-youtube'),
      JSON.stringify(scriptsAfter));
    const setsAfter = await sw.eval('chrome.declarativeNetRequest.getEnabledRulesets()');
    check('a forged licence cannot enable Pro rulesets',
      !setsAfter.some((id) => id.startsWith('pro-')), JSON.stringify(setsAfter));
    // Open the real popup: a service worker cannot sendMessage to itself, so
    // the only honest way to check the popup's behaviour is to render it.
    const pop = await newPage(`chrome-extension://${extId}/popup.html`);
    await sleep(1200);
    const pf = (await cdpList()).find((x) => x.id === pop.id);
    const pc = connect(pf.webSocketDebuggerUrl);
    await pc.ready;
    const hidden = await pc.eval("document.getElementById('proCard').hidden");
    check('popup hides the Pro card', hidden === true, `hidden=${hidden}`);

    // A free build has no licence code, so the Pro card cannot work — but the
    // teaser should still tell people Pro exists.
    const teaserShown = await pc.eval("document.getElementById('teaserCard').hidden === false");
    check('popup shows the Pro teaser instead', teaserShown === true, `shown=${teaserShown}`);
    const teaserBtn = await pc.eval("document.getElementById('teaserBtn').textContent");
    check('teaser has a call to action', /Pro/.test(teaserBtn || ''), JSON.stringify(teaserBtn));
    pc.close();
    await fetch(`${CDP}/json/close/${pop.id}`).catch(() => {});
  } else {
  console.log('\nPro');
    // Writing the licence is enough on its own — background.js reconciles on
    // storage.local `license` changes. (Do NOT try to force it with a second
    // write of an unchanged value: Chrome de-duplicates those and fires nothing.)
    await sw.eval(`chrome.storage.local.set({license:{key:'TEST',plan:'pro',expiresAt:Date.now()+864e5,lastCheck:Date.now(),lastGoodCheck:Date.now()}})`);
    await sleep(1800);
    const pro = await sw.eval('chrome.scripting.getRegisteredContentScripts().then(s=>s.map(x=>x.id+":"+x.world))');
    check('scriptlets registered in MAIN world', pro.includes('tab-scriptlets:MAIN'), JSON.stringify(pro));
    check('youtube registered in MAIN world', pro.includes('tab-youtube:MAIN'), JSON.stringify(pro));
    const proSets = await sw.eval('chrome.declarativeNetRequest.getEnabledRulesets()');
    check('Pro anti-adblock rulesets enabled',
      proSets.some((id) => id.startsWith('pro-')), JSON.stringify(proSets));
    v = await probePage();
    check('anti-adblock flag pinned on live page', v.flag === 'false', v.flag);

    console.log('\nPro revocation');
    await sw.eval('chrome.storage.local.set({license:{key:null,plan:"free",expiresAt:null,lastCheck:0,lastGoodCheck:0}})');
    await sleep(1800);
    const revoked = await sw.eval('chrome.declarativeNetRequest.getEnabledRulesets()');
    check('Pro rulesets disabled when licence lapses',
      !revoked.some((id) => id.startsWith('pro-')), JSON.stringify(revoked));
    const revokedScripts = await sw.eval('chrome.scripting.getRegisteredContentScripts().then(s=>s.map(x=>x.id))');
    check('Pro content scripts unregistered when licence lapses',
      !revokedScripts.includes('tab-scriptlets') && !revokedScripts.includes('tab-youtube'),
      JSON.stringify(revokedScripts));

  }

  // ---- localisation -----------------------------------------------------
  // If the catalogue is broken, Chrome either refuses to load the extension or
  // ships the literal text "__MSG_extName__" as its public name on the store.
  // The extension having loaded at all is most of the evidence; assert the
  // rest so a half-wired locale cannot pass quietly.
  console.log('\nLocalisation');
  {
    const name = await sw.eval(`chrome.i18n.getMessage('extName')`);
    check('extName resolves', !!name && !name.includes('__MSG_'), JSON.stringify(name));
    check('extName keeps the brand', typeof name === 'string' && name.startsWith('Ad Interceptor'), JSON.stringify(name));
    check('extName within Chrome\'s 75-char limit', typeof name === 'string' && name.length <= 75, `${name?.length} chars`);

    const desc = await sw.eval(`chrome.i18n.getMessage('extDescription')`);
    check('extDescription resolves', !!desc && !desc.includes('__MSG_'), JSON.stringify(desc?.slice(0, 40)));
    check('extDescription within the 132-char limit', typeof desc === 'string' && desc.length <= 132, `${desc?.length} chars`);

    const tip = await sw.eval(`chrome.i18n.getMessage('actionTitle')`);
    check('toolbar tooltip is the brand alone', tip === 'Ad Interceptor', JSON.stringify(tip));
  }

  // ---- review prompt ----------------------------------------------------
  // A service worker cannot sendMessage to itself, and shouldAskForReview is
  // module-scoped so Runtime.evaluate cannot reach it. So drive it the way a
  // user does: seed storage, render the popup, look at the card.
  console.log('\nReview prompt');
  {
    const DAY = 86400000;

    /** Seed state, open the popup, report whether the card showed. */
    async function askedWith(state) {
      await sw.eval(`chrome.storage.local.remove(['reviewAsked','installedAt','blockedTotal'])`);
      await sw.eval(`chrome.storage.local.set(${JSON.stringify(state)})`);
      const pop = await newPage(`chrome-extension://${extId}/popup.html`);
      await sleep(1200);
      const t = (await cdpList()).find((x) => x.id === pop.id);
      const pc = connect(t.webSocketDebuggerUrl);
      await pc.ready;
      const shown = await pc.eval("document.getElementById('reviewCard').hidden === false");
      const count = await pc.eval("document.getElementById('reviewCount').textContent");
      pc.close();
      await fetch(`${CDP}/json/close/${pop.id}`).catch(() => {});
      return { shown, count };
    }

    const fresh = await askedWith({ installedAt: Date.now(), blockedTotal: 0 });
    check('not asked on a fresh install', fresh.shown === false);

    const soon = await askedWith({ installedAt: Date.now() - 2 * DAY, blockedTotal: 5000 });
    check('not asked before 7 days, however much was blocked', soon.shown === false);

    const quiet = await askedWith({ installedAt: Date.now() - 30 * DAY, blockedTotal: 100 });
    check('not asked when it has barely blocked anything', quiet.shown === false);

    const earned = await askedWith({ installedAt: Date.now() - 8 * DAY, blockedTotal: 1200 });
    check('asked once both thresholds are met', earned.shown === true);
    check('the ask states the real blocked count', earned.count === '1,200', earned.count);

    // The card sets reviewAsked as soon as it renders, so a second open must
    // stay quiet even though the thresholds are still met. This is the whole
    // difference between asking and nagging.
    const marked = await sw.eval(`chrome.storage.local.get('reviewAsked').then(r => !!r.reviewAsked)`);
    check('showing the card records that we asked', marked === true);

    const pop2 = await newPage(`chrome-extension://${extId}/popup.html`);
    await sleep(1200);
    const t2 = (await cdpList()).find((x) => x.id === pop2.id);
    const pc2 = connect(t2.webSocketDebuggerUrl);
    await pc2.ready;
    const again = await pc2.eval("document.getElementById('reviewCard').hidden");
    check('never asked a second time', again === true, `hidden=${again}`);
    pc2.close();
    await fetch(`${CDP}/json/close/${pop2.id}`).catch(() => {});

    await sw.eval(`chrome.storage.local.remove(['reviewAsked','installedAt','blockedTotal'])`);
  }

  sw.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
} catch (err) {
  console.error('\nverify failed:', err.message);
  fail++;
} finally {
  await cleanup();
}

process.exit(fail ? 1 : 0);
