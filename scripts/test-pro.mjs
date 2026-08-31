// Exercise scriptlets.js and youtube.js in a stubbed page context.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname — the latter leaves spaces percent-encoded.
const EXT = fileURLToPath(new URL('..', import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}`);
  cond ? pass++ : fail++;
};

function makeContext(hostname) {
  const listeners = {};
  const doc = {
    readyState: 'loading',
    documentElement: { style: { setProperty() {} } },
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {} }),
  };
  const ctx = {
    console,
    JSON,
    Object,
    Array,
    Number,
    Promise,
    ReferenceError,
    Proxy,
    document: doc,
    location: { hostname },
    MutationObserver: class { observe() {} },
    Response: function Response() {},
    HTMLElement: class {},
    fire: (t) => (listeners[t] || []).forEach((f) => f()),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.Response.prototype.json = function () { return Promise.resolve(this._body); };
  return vm.createContext(ctx);
}

// ---------------- scriptlets.js ----------------
console.log('\nscriptlets.js — anti-adblock');
{
  const ctx = makeContext('somenewssite.com');
  vm.runInContext(readFileSync(`${EXT}/scriptlets.js`, 'utf8'), ctx);

  check('blockAdBlock pinned to false', vm.runInContext('window.blockAdBlock === false', ctx));
  check('canRunAds pinned to true', vm.runInContext('window.canRunAds === true', ctx));

  // The core requirement: the page writes the flag, and the read still lies.
  vm.runInContext('window.blockAdBlock = true; window.canRunAds = false;', ctx);
  check('page write to blockAdBlock is swallowed', vm.runInContext('window.blockAdBlock === false', ctx));
  check('page write to canRunAds is swallowed', vm.runInContext('window.canRunAds === true', ctx));

  // Detector *function names* must be left alone globally: pinning them would
  // make a page's `function detectAdBlock(){}` declaration throw a TypeError
  // and abort the whole script it lives in. See the note in scriptlets.js.
  check('detector function names not pinned globally',
    vm.runInContext('!("detectAdBlock" in window) && !("checkAdBlocker" in window)', ctx));

  // A page redefining a flag as a function must not throw either.
  check('flag stays pinned after page reassignment',
    vm.runInContext('(() => { try { window.canRunAds = function () {}; } catch (e) { return false; } return window.canRunAds === true; })()', ctx));
}

// ---------------- youtube.js ----------------
console.log('\nyoutube.js — ad stripping');
{
  const ctx = makeContext('www.youtube.com');
  vm.runInContext(readFileSync(`${EXT}/youtube.js`, 'utf8'), ctx);

  // 1. cold load via ytInitialPlayerResponse
  vm.runInContext(`
    window.ytInitialPlayerResponse = {
      adPlacements: [{ x: 1 }], playerAds: [{ y: 2 }], adSlots: [1],
      videoDetails: { videoId: 'abc' }
    };
  `, ctx);
  check('adPlacements stripped from ytInitialPlayerResponse',
    vm.runInContext('!("adPlacements" in window.ytInitialPlayerResponse)', ctx));
  check('playerAds stripped', vm.runInContext('!("playerAds" in window.ytInitialPlayerResponse)', ctx));
  check('adSlots stripped', vm.runInContext('!("adSlots" in window.ytInitialPlayerResponse)', ctx));
  check('videoDetails preserved',
    vm.runInContext('window.ytInitialPlayerResponse.videoDetails.videoId === "abc"', ctx));

  // 2. JSON.parse path
  const parsed = vm.runInContext(
    'JSON.parse(\'{"adPlacements":[1],"streamingData":{"ok":1}}\')', ctx);
  check('JSON.parse strips ads', !('adPlacements' in parsed));
  check('JSON.parse preserves streamingData', parsed.streamingData.ok === 1);

  // Non-player JSON must pass through completely untouched.
  const plain = vm.runInContext('JSON.parse(\'{"title":"hello","items":[1,2]}\')', ctx);
  check('unrelated JSON untouched', plain.title === 'hello' && plain.items.length === 2);

  // 3. fetch path
  const ok = await vm.runInContext(`
    (() => {
      const r = new Response();
      r._body = { adPlacements: [1], playerResponse: { adSlots: [2], keep: 3 } };
      return r.json().then(d => !("adPlacements" in d) && !("adSlots" in d.playerResponse) && d.playerResponse.keep === 3);
    })()
  `, ctx);
  check('Response.json strips ads incl. nested playerResponse', ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
