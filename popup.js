// popup.js — writes settings only. background.js is the single place that
// acts on them (DNR rulesets, allowlist rules, content scripts).

// Whether blocking is on, and whether this particular site is paused, are set
// by two independent sections of the UI but describe one combined state. Held
// here so the header can state it in one sentence instead of each section
// half-answering it.
const state = {
  enabled: true,
  paused: false,
  hostname: null,
  hasSite: false
};

function render() {
  const { enabled, paused, hostname, hasSite } = state;
  const off = !enabled;
  const sitePaused = enabled && paused;

  document.body.classList.toggle('is-off', off);
  document.body.classList.toggle('is-paused', sitePaused);

  document.getElementById('statusText').textContent =
    off ? 'Protection off'
      : sitePaused ? `Paused on ${hostname}`
        : 'Protection active';

  // The site card is rendered from the same state as the header, so the two
  // can't disagree — it previously still read "Blocking active" while the
  // header said "Protection off".
  const siteStatus = document.getElementById('siteStatus');
  const btn = document.getElementById('siteToggleBtn');

  if (!hasSite) {
    siteStatus.textContent = 'Nothing to pause here';
    btn.disabled = true;
    return;
  }

  siteStatus.textContent =
    off ? 'Blocking is off everywhere'
      : paused ? 'Blocking paused here'
        : 'Blocking active';

  // Pausing one site is meaningless while everything is already off.
  btn.disabled = off;
  btn.textContent = paused ? 'Resume' : 'Pause';
  btn.classList.toggle('is-paused', paused && !off);
}

document.addEventListener('DOMContentLoaded', () => {
  initMasterToggle();
  initSiteToggle();
  initPro();
  initStats();
  initReviewPrompt();
});

// ----------------------------
// 📨 Messaging
// ----------------------------
function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      // Service worker asleep or restarting — treat as "no answer".
      if (chrome.runtime.lastError) return resolve(null);
      resolve(res);
    });
  });
}

// ----------------------------
// 🛡️ Master on/off
// ----------------------------
function initMasterToggle() {
  const adsToggle = document.getElementById('adsToggle');
  const savedFlash = document.getElementById('savedFlash');
  const footer = document.getElementById('footer');
  let flashTimer = null;

  chrome.storage.sync.get({ ads: true }, ({ ads }) => {
    adsToggle.checked = ads;
    state.enabled = ads;
    render();
  });

  adsToggle.addEventListener('change', () => {
    state.enabled = adsToggle.checked;
    render();
    chrome.storage.sync.set({ ads: adsToggle.checked }, () => {
      footer.classList.add('visible');
      savedFlash.classList.add('visible');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        savedFlash.classList.remove('visible');
        footer.classList.remove('visible');
      }, 1200);
    });
  });
}

// ----------------------------
// 🔢 Stats
// ----------------------------
function initStats() {
  const pageEl = document.getElementById('statPage');
  const totalEl = document.getElementById('statTotal');

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tabId = tabs && tabs[0] ? tabs[0].id : null;
    const stats = await send('stats:get', { tabId });
    if (!stats) return;
    pageEl.textContent = stats.page.toLocaleString();
    totalEl.textContent = stats.total.toLocaleString();
  });
}

// ----------------------------
// ⭐ Review prompt
// ----------------------------
// background.js owns the "should we ask" decision (see shouldAskForReview);
// this only renders the answer. Shown at most once ever — 'review:asked' is
// sent as soon as the card appears, so ignoring it counts as an answer.
function initReviewPrompt() {
  const card = document.getElementById('reviewCard');
  const countEl = document.getElementById('reviewCount');
  const rateBtn = document.getElementById('reviewRateBtn');
  const dismissBtn = document.getElementById('reviewDismissBtn');

  send('review:check').then(async (res) => {
    if (!res?.ask) return;

    const stats = await send('stats:get');
    countEl.textContent = stats ? stats.total.toLocaleString() : 'plenty of';

    card.hidden = false;
    send('review:asked');
  });

  rateBtn.addEventListener('click', () => {
    // Built from chrome.runtime.id rather than a hardcoded item id, so it
    // cannot drift from the listing and works in an unpacked dev load too.
    chrome.tabs.create({
      url: `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`
    });
    window.close();
  });

  dismissBtn.addEventListener('click', () => {
    card.hidden = true;
  });
}

// ----------------------------
// ✨ Pro
// ----------------------------
function initPro() {
  const card = document.getElementById('proCard');
  const badge = document.getElementById('proBadge');
  const form = document.getElementById('proForm');
  const input = document.getElementById('licenseKey');
  const activateBtn = document.getElementById('activateBtn');
  const removeBtn = document.getElementById('removeBtn');
  const message = document.getElementById('proMessage');

  function say(text, isError) {
    message.textContent = text;
    message.classList.toggle('error', !!isError);
    message.hidden = !text;
  }

  const teaserCard = document.getElementById('teaserCard');
  const teaserBtn = document.getElementById('teaserBtn');

  // Straight to /pricing. It was originally the landing page, to avoid
  // dropping anyone into a sandbox payment form — but /pricing now gates the
  // buy button and reads "Not on sale yet" until the account goes live, so
  // that risk is gone. Landing on the homepage put the Pro section four
  // scrolls down behind three other sections, ending in an inline text link.
  // A button labelled "See what Pro adds" has to actually show what Pro adds.
  teaserBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://ad-interceptor.pages.dev/pricing' });
    window.close();
  });

  function renderPro(status) {
    // Free-only builds compile Pro out entirely (see config.js). Hide the
    // whole card rather than showing a licence box that cannot work, and show
    // the teaser in its place so free users at least know Pro exists.
    if (status && status.available === false) {
      card.hidden = true;
      teaserCard.hidden = !status.teaser;
      return;
    }
    teaserCard.hidden = true;
    const active = !!status?.pro;
    badge.textContent = active ? 'Active' : 'Inactive';
    badge.classList.toggle('active', active);
    form.hidden = active;
    removeBtn.hidden = !active;
  }

  send('license:status').then(renderPro);

  activateBtn.addEventListener('click', async () => {
    activateBtn.disabled = true;
    say('Checking…', false);

    const res = await send('license:activate', { key: input.value });

    activateBtn.disabled = false;

    if (!res) {
      say('Something went wrong. Try again.', true);
      return;
    }
    // A failed *check* (network/server) reads differently to a valid answer
    // of "this key isn't Pro" — don't collapse the two into one message.
    if (res.error) {
      say(res.error, true);
    } else {
      say('Pro activated. Thank you!', false);
      input.value = '';
    }
    renderPro(res.status);
  });

  removeBtn.addEventListener('click', async () => {
    const res = await send('license:clear');
    say('Licence removed.', false);
    renderPro(res?.status);
  });
}

// ----------------------------
// 🌐 Per-site pause
// ----------------------------
function getHostname(url) {
  try {
    return new URL(url).hostname || null;
  } catch (e) {
    return null; // chrome://, about:, file:// without a real host, etc.
  }
}

function initSiteToggle() {
  const siteHost = document.getElementById('siteHost');
  const siteToggleBtn = document.getElementById('siteToggleBtn');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    const hostname = tab && tab.url ? getHostname(tab.url) : null;

    if (!hostname) {
      siteHost.textContent = 'No site on this page';
      state.hasSite = false;
      render();
      return;
    }

    state.hostname = hostname;
    state.hasSite = true;
    siteHost.textContent = hostname;

    chrome.storage.sync.get({ allowlist: [] }, ({ allowlist }) => {
      state.paused = allowlist.includes(hostname);
      render();
    });

    siteToggleBtn.onclick = () => {
      chrome.storage.sync.get({ allowlist: [] }, ({ allowlist }) => {
        const next = state.paused
          ? allowlist.filter((d) => d !== hostname)
          : [...allowlist, hostname];

        chrome.storage.sync.set({ allowlist: next }, () => {
          // Rules only apply to future requests, so the current page needs
          // a reload to actually reflect the change.
          if (tab.id != null) chrome.tabs.reload(tab.id);
          window.close();
        });
      });
    };
  });
}
