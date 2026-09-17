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

// ---------------- userfilters.js ----------------
// Imported directly rather than run through the vm sandbox: this module is
// deliberately free of chrome.* and DOM, which is the whole reason its logic
// can be tested here instead of only in a browser run.
console.log('\nuserfilters.js — parsing');
{
  const uf = await import(`${EXT}/userfilters.js`);
  const ok = (text) => uf.parseRule(text);

  check('hide rule with a domain', (() => {
    const r = ok('example.com##.ad-slot');
    return r.ok && r.rule.kind === 'hide' && r.rule.domains[0] === 'example.com'
      && r.rule.selector === '.ad-slot';
  })());

  check('hide rule with no domain is global', (() => {
    const r = ok('##.ad-slot');
    return r.ok && r.rule.kind === 'hide' && r.rule.domains.length === 0;
  })());

  check('multiple domains', (() => {
    const r = ok('a.com,b.com##.promo');
    return r.ok && r.rule.domains.length === 2;
  })());

  check('unhide rule', (() => {
    const r = ok('example.com#@#.promo');
    return r.ok && r.rule.kind === 'unhide';
  })());

  check('network rule', (() => {
    const r = ok('||ads.example.com^');
    return r.ok && r.rule.kind === 'block' && r.rule.host === 'ads.example.com';
  })());

  check('comments and blanks produce no rule',
    ok('! a note').rule === null && ok('   ').rule === null);

  // --- the rejections. Each of these WOULD have been silently accepted by a
  // looser parser and then never matched anything, which is the failure mode
  // this module exists to prevent.
  check('extended CSS rejected', !ok('example.com#?#div:has(.ad)').ok);
  check('scriptlet injection rejected', !ok('example.com##+js(nowebrtc)').ok);
  check('declaration block rejected', !ok('example.com##.a { color: red }').ok);
  check('unbalanced bracket rejected', !ok('example.com##.a[href="x"').ok);
  check('unbalanced paren rejected', !ok('example.com##.a:not(.b').ok);
  check('wildcard domain rejected', !ok('example.*##.ad').ok);
  check('negated domain rejected', !ok('~example.com##.ad').ok);
  check('global unhide rejected', !ok('#@#.promo').ok);
  check('@@ exception points at per-site pause', (() => {
    const r = ok('@@||example.com^');
    return !r.ok && /pause/i.test(r.error);
  })());
  check('garbage rejected with guidance', (() => {
    const r = ok('just some words');
    return !r.ok && /example\.com##/.test(r.error);
  })());
  check('over-long rule rejected', !ok(`example.com##.${'a'.repeat(250)}`).ok);

  console.log('\nuserfilters.js — host matching');
  const rules = uf.parseRules([
    'example.com##.ad',
    'other.com##.banner',
    '##.global-ad',
    'example.com#@#.keep'
  ].join('\n')).rules;

  check('subdomain inherits the parent domain rule', (() => {
    const c = uf.cosmeticFor(rules, 'www.example.com');
    return c.selectors.includes('.ad');
  })());
  check('global rule applies to an unrelated host', (() => {
    const c = uf.cosmeticFor(rules, 'nothing-to-do-with-it.net');
    return c.selectors.includes('.global-ad') && !c.selectors.includes('.ad');
  })());
  check('another domain\'s rule does not leak', (() => {
    const c = uf.cosmeticFor(rules, 'example.com');
    return !c.selectors.includes('.banner');
  })());
  check('unhide is scoped to its domain', (() => {
    const mine = uf.cosmeticFor(rules, 'example.com');
    const theirs = uf.cosmeticFor(rules, 'other.com');
    return mine.unhide.includes('.keep') && theirs.unhide.length === 0;
  })());
  console.log('\nuserfilters.js — host candidates');
  check('subdomains walk up to the registrable domain', (() => {
    const c = uf.hostCandidates('news.bbc.co.uk');
    return c[0] === 'news.bbc.co.uk' && c.includes('bbc.co.uk');
  })());
  check('a bare TLD is never a candidate', !uf.hostCandidates('news.bbc.co.uk').includes('uk'));
  check('a two-label host yields itself', (() => {
    const c = uf.hostCandidates('example.com');
    return c.length === 1 && c[0] === 'example.com';
  })());
  // Regression: the loop used to stop before single-label hosts, so a rule
  // written for localhost or an intranet name matched nothing, silently.
  check('a SINGLE-label host still yields itself', (() => {
    const c = uf.hostCandidates('localhost');
    return c.length === 1 && c[0] === 'localhost';
  })());
  check('a rule on a single-label host actually applies', (() => {
    const rules = uf.parseRules('localhost##.ad').rules;
    return uf.cosmeticFor(rules, 'localhost').selectors.includes('.ad');
  })());

  // example.com must NOT be matched by a host that merely ends with the same
  // letters — the classic suffix-matching hole.
  check('notexample.com is not a subdomain of example.com', (() => {
    const c = uf.cosmeticFor(rules, 'notexample.com');
    return !c.selectors.includes('.ad');
  })());

  console.log('\nuserfilters.js — compiling and limits');
  check('only block rules compile to DNR rules', (() => {
    const compiled = uf.compileNetworkRules(
      uf.parseRules('example.com##.ad\n||ads.example.com^').rules,
      { idBase: 1000, maxRules: 500, priority: 1500000 }
    );
    return compiled.length === 1 && compiled[0].id === 1000
      && compiled[0].condition.urlFilter === '||ads.example.com^'
      && compiled[0].action.type === 'block';
  })());

  check('compiled ids stay inside their partition', (() => {
    const many = Array.from({ length: 20 }, (_, i) => `||a${i}.example.com^`).join('\n');
    const compiled = uf.compileNetworkRules(uf.parseRules(many).rules,
      { idBase: 1000, maxRules: 5, priority: 1 });
    return compiled.length === 5 && compiled.at(-1).id === 1004;
  })());

  check('rule-count limit is enforced', (() => {
    const tooMany = Array.from({ length: uf.MAX_USER_RULES + 1 }, (_, i) => `a${i}.com##.x`);
    return /Too many/.test(uf.checkStorable(tooMany) || '');
  })());

  check('sync byte budget is enforced', (() => {
    // Few rules, but long ones — the case a count-only limit would let through
    // and storage.sync would then reject asynchronously. 50 is comfortably
    // under MAX_USER_RULES, so a pass here can only come from the byte check.
    const fat = Array.from({ length: 50 }, (_, i) => `d${i}.com##.${'x'.repeat(150)}`);
    return /too large/.test(uf.checkStorable(fat) || '');
  })());

  check('a normal list is storable', uf.checkStorable(['example.com##.ad']) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
