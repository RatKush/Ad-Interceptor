// options.js — the custom filter editor.
//
// Same rule as popup.js: this page reads and writes, background.js decides.
// Every rule that goes in is parsed by background.js through userfilters.js, so
// the validation the user sees here and the validation that actually gates
// storage are the same code — a UI that accepted something the backend rejects
// would be worse than no validation at all.
//
// A textarea, not a row-per-rule list. Filter rules are text, people keep them
// in text files and paste them between blockers, and a list UI makes editing
// forty rules into forty interactions.

const $ = (id) => document.getElementById(id);

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(res);
    });
  });
}

const rules = $('rules');
const meter = $('meter');
const countText = $('countText');
const byteText = $('byteText');
const message = $('message');
const errorBox = $('errorBox');
const errorList = $('errorList');
const saveBtn = $('saveBtn');
const revertBtn = $('revertBtn');

let saved = '';   // last known stored text, for Revert and the dirty check
let max = 150;

const lines = (text) =>
  text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('!'));

function say(text, kind) {
  message.textContent = text;
  message.className = `msg ${kind || ''}`;
}

function updateMeter() {
  const n = lines(rules.value).length;
  const bytes = new TextEncoder().encode(JSON.stringify(lines(rules.value))).length;
  countText.textContent = `${n} of ${max} rules`;
  // Sync storage caps one item at 8,192 bytes. Showing the number before the
  // save rather than after it is the difference between "nearly full" and a
  // rejected save the user has to diagnose.
  byteText.textContent = `${bytes} bytes used of 7000`;
  meter.classList.toggle('over', n > max || bytes > 7000);
}

function showErrors(errors) {
  if (!errors || !errors.length) {
    errorBox.hidden = true;
    return;
  }
  errorList.replaceChildren(...errors.map(({ line, text, error }) => {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = text || '(blank)';
    li.append(`Line ${line}: `, code, ` — ${error}`);
    return li;
  }));
  errorBox.hidden = false;
}

async function load() {
  const status = await send('settings:get');

  // Free builds compile Pro out entirely, and a lapsed licence leaves the page
  // reachable. Either way there is nothing here the user can act on, so show
  // why rather than an editor whose Save button always fails.
  if (!status || !status.pro) {
    $('lockedCard').hidden = false;
    return;
  }

  $('editorCard').hidden = false;
  const res = await send('userfilters:list');
  max = res?.max ?? max;
  saved = (res?.filters ?? []).join('\n');
  rules.value = saved;
  updateMeter();
}

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  say('Saving…');

  const res = await send('userfilters:set', { lines: rules.value.split(/\r?\n/) });
  saveBtn.disabled = false;

  if (!res) return say('Could not reach the extension. Try again.', 'err');
  if (res.error) {
    showErrors(res.errors);
    return say(res.error, 'err');
  }

  // Rewrite the box from what was actually stored, not from what was typed.
  // Invalid lines are dropped by the backend, and leaving them on screen would
  // imply they survived.
  saved = (res.filters ?? []).join('\n');
  rules.value = saved;
  updateMeter();
  showErrors(res.errors);

  const skipped = res.errors?.length ?? 0;
  say(skipped ? `Saved ${res.count} rules, skipped ${skipped}.` : `Saved ${res.count} rules.`,
    skipped ? '' : 'ok');
});

revertBtn.addEventListener('click', () => {
  rules.value = saved;
  updateMeter();
  showErrors([]);
  say('');
});

rules.addEventListener('input', () => {
  updateMeter();
  say('');
});

// A rule the user typed and did not save is silently lost on navigation, and
// this page is usually opened from a popup that has already closed — so there
// is no obvious way back to what they wrote.
window.addEventListener('beforeunload', (e) => {
  if (rules.value !== saved && !$('editorCard').hidden) e.preventDefault();
});

document.addEventListener('DOMContentLoaded', load);
