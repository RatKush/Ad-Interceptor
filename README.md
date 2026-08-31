# Ad Interceptor

A Chrome extension (Manifest V3) with one job: block ads. Banners, pop-ups,
pop-unders, video ads and the tracking infrastructure behind them.

published on Chrome Web store:

https://chromewebstore.google.com/detail/ad-interceptor/oghcaogilkdcnofflfkejobjolinkmpp?authuser=2&hl=en


<img width="1433" height="881" alt="image" src="https://github.com/user-attachments/assets/c2b24fa3-a583-4944-b7b9-b43b2fe8d18d" />


Formerly "Data Saver" (v2.x), which also blocked images and video generally.
As of v3.0 that scope is gone — this is an ad blocker, nothing else.

## How it works

Blocking layers:

| Layer | Where | Size | Tier |
|---|---|---|---|
| Supplemental rules (ours) | `filters/custom.txt` → `rules/custom-1.json` | 6 | Free |
| Static network rules | `rules/filters-1..6.json` | 108,191 | Free |
| Cosmetic element hiding | `filters/filters-generic.css` + `-cosmetic.json` | 13,634 generic selectors + 7,696 domains | Free |
| Blocked counter | badge + popup, via `getMatchedRules()` | — | Free |
| Anti-adblock rules | `rules/pro-1.json` + `filters/pro-generic.css` | 2,512 + 144 selectors / 428 domains | Pro |
| Anti-adblock scriptlets | `scriptlets.js` (MAIN world) | generic flag pinning | Pro |
| YouTube ad removal | `youtube.js` (MAIN world) | — | Pro |
| Daily filter refresh | server-delivered, `license.js` | additive, dynamic store | Pro |

Plus a **per-site pause**, and a master on/off — both implemented as
high-priority `allowAllRequests` rules so toggling is instant.

## Pro

**v3.0 ships free-only.** `config.js` sets `PRO_ENABLED = false`.

That flag is the whole switch, and it is a *build-time* one, not just a UI
toggle. With it false:

- `scripts/package.sh` ships `license-stub.js` as `license.js` — same API, no
  URLs, no `fetch()` — and omits `scriptlets.js`, `youtube.js` and every
  `pro-*` ruleset from the .zip and from the packaged manifest
- `scripts/audit-package.mjs` fails the build if any shipped code contains an
  external URL, a `fetch()` to a non-packaged target, `XMLHttpRequest`,
  `sendBeacon` or `WebSocket`
- the popup hides the Pro card
- `npm run verify` swaps in tests asserting Pro is genuinely absent — including
  that a forged licence written straight into storage still cannot enable it

The point is that the Chrome Web Store disclosure "collects nothing" is
checkable from the artifact, not merely true of the running code.

Note `background.js` imports `./license.js` **statically**. It has to:
`import()` is disallowed inside a service worker by the HTML spec
([w3c/ServiceWorker#1356](https://github.com/w3c/ServiceWorker/issues/1356)).
An earlier attempt at a dynamic import silently broke every Pro path. That is
why the free build swaps the module rather than dropping it.

### Turning Pro on later

1. Stand up the backend and replace the `api.example.com` placeholders in
   `license.js` (`LICENSE_API`, `PRO_FILTERS_API`)
2. Set `PRO_ENABLED = true` in `config.js`
3. `npm run build` — regenerates the manifest with the `pro-*` rulesets
4. `npm run verify` — the Pro test path runs instead of the free one
5. Update the CWS data disclosure to declare **Authentication information**,
   and restore the held-back Pro block in `store-listing/description.md`

Payment is planned via **Paddle** (merchant of record — they handle global
VAT/sales tax as the legal seller). The licence server does not exist yet.

What Pro can and cannot enforce:

- **Enforceable:** the daily filter refresh. Those rules aren't in the package;
  the request carries the licence key and the server decides.
- **Partly enforceable:** the anti-adblock rulesets ship in the package but are
  disabled in the manifest and only enabled by `background.js` for licensed
  users (`syncStaticRulesets`).
- **Not enforceable:** YouTube blocking and the scriptlets. That code ships to
  every user's disk and can be re-enabled by editing one flag. MV3 forbids
  remotely-hosted code, so there is no way to withhold it. Treat the gate as
  friction for honest customers, not as DRM.

Pro delivers *extra* lists and *fresher* updates, never a carve-out — the free
tier keeps all 108,068 rules permanently. Degrading the free tier to manufacture a paid one
would cost more in ratings than it earns.

### Why the rules are chunked

`GUARANTEED_MINIMUM_STATIC_RULES` is 30,000, but that is a **floor, not a cap**
— the real allowance comes from a global pool shared with other installed
extensions. Measured on a clean profile: all 108,065 rules load with ~222,000
quota still spare.

So the filters ship as six free rulesets (plus one Pro) with only the first enabled in the
manifest, and `background.js` enables the rest one at a time, stopping at the
first refusal. That self-corrects to whatever quota the user actually has.

Rules are ordered so a partially-enabled set is still a *correct* set: every
exception rule sits in chunk 1, because an exception that is disabled while the
block it corrects stays active breaks the site it was written to protect.

Dynamic rule IDs are partitioned — `1` master off switch, `2–999` per-site
allowlist, `1000+` Pro server-refreshed rules — because they share one store.

## Development

```bash
npm install       # build-time only; never shipped
npm run build     # refresh all filter data from EasyList
npm test          # exercise scriptlets.js + youtube.js against a stubbed page
npm run verify    # load the extension into real Chrome/Edge and check it blocks
npm run store     # composite design/ renders into store listing images
npm run package   # build dist/ad-interceptor-vX.Y.zip
```

Run `npm test` after any YouTube change — that script is the early warning for
YouTube shifting their player response shape, which is the single most common
way this extension breaks.

**Run `npm run verify` before every release.** Most of this extension is
configuration of browser APIs, which fail at runtime and silently. That script
found a bug where `unregisterContentScripts()` rejects the entire call if any
id is not currently registered — which had silently broken per-site pause and
Pro activation for every user, while every static check passed.

Load unpacked from `chrome://extensions` with Developer mode on.

Re-run `build-filters.mjs` before each release — filter lists change daily, and
stale rules are the main cause of "ads started getting through".

### Supplemental rules

`filters/custom.txt` is our own list, in normal Adblock Plus syntax, for ads
the upstream lists miss or deliberately under-block. It builds into
`rules/custom-1.json`, which is listed **first** in the manifest and always
enabled, so a fix can never be the ruleset dropped when quota runs short.

Use `$important` there for domains upstream under-blocks: it outranks EasyList
exceptions but still sits below the per-site pause and master-off overrides
(priority 2,000,000), so the user can always overrule us.

Every entry must record the date, the report, and why upstream didn't cover
it — a rule without that context is one nobody can safely remove later. Add a
matching probe in `scripts/verify.mjs` so the fix is a regression test.

**Worked example (2026-08-29).** Ads from `*.html-load.com` were reported
visible on catforum.com and cookieandkate.com. EasyList carries the domain but
only as `$popup` / `$document,popup`, which converts to a `main_frame`-only DNR
rule — so the ad, an `image/png` creative, was never blocked. The host also
rotates subdomains and embeds the visited site's own hostname in a randomised
path to look first-party. Fixed with `||html-load.com^$important` plus its
sibling domains, and covered by three probes in the verify suite.

### Where the anti-adblock coverage comes from

EasyList's dedicated **Adblock Warning Removal List** (2,970 rules, rebuilt
daily), not a hand-written table. This was a deliberate call: EasyList's own
lists carry only 26 scriptlet rules between them, and uBlock's rich scriptlet
lists are GPL, so the realistic options were a table we'd have to guess at and
maintain alone, or a list maintained by people who actually track these sites.

`scriptlets.js` still handles what a filter list cannot — pinning JavaScript
flags like `canRunAds` that detector scripts read directly.

## Release checklist

```bash
npm run build     # refresh filters (also regenerates manifest rule_resources)
npm test          # unit
npm run verify    # real browser, tier-aware
npm run design    # popup renders
npm run store     # listing images — copy reads live rule counts
npm run package   # audited .zip
```

Order matters: `store` reads `design/`, and both read the counts produced by
`build`. Running them out of order ships listing images quoting stale numbers.

## Licensing

Filter data comes from EasyList/EasyPrivacy under CC BY-SA 3.0. The GPL-3.0
converter is a build-time devDependency and must never be bundled. See
[ATTRIBUTION.md](ATTRIBUTION.md) — read it before adding any filtering
dependency.
