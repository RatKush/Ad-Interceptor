# Paddle business verification — what to do, in order

Paddle is the **merchant of record** for Pro: it becomes the legal seller and
handles global VAT/sales tax. That is why it needs to verify you before you can
take a single payment, and why this has lead time that code cannot remove.

Nothing in `backend/` can be used commercially until this clears. Start it
first; the deploy is an afternoon's work afterwards.

Sources: [Account Verification](https://www.paddle.com/help/start/account-verification),
[Domain Review](https://www.paddle.com/help/start/account-verification/what-is-domain-verification),
[Business Identification](https://www.paddle.com/help/start/account-verification/what-is-business-verification),
[Setup checklist](https://developer.paddle.com/build/onboarding/set-up-checklist).

---

## The three phases

Paddle verifies in three separate passes. They can run in parallel, but
**domain review is the one that will actually block you**, because it depends
on pages that do not exist yet.

| Phase | What it checks | Our status |
|---|---|---|
| **Domain review** | the website you sell from | ⚠️ pages written, **NOT YET DEPLOYED** |
| **Business identification** | who legally owns the business | ✅ individual — no ownership docs needed |
| **Identity verification** | that you are you | ⚠️ ID + proof of address, possibly a liveness video |

Business identification is often instant. When it goes to manual review,
Paddle targets **2–4 business days**.

---

## Phase 1: domain review — the real blocker

Paddle requires all of the following to be live and reachable by navigation on
the domain you check out from:

1. **Product description** — what is being sold
2. **Pricing details** — a pricing page (Paddle accepts a screenshot if the
   page is not live yet)
3. **Features / deliverables** — what the buyer actually gets
4. **Terms & Conditions**
5. **Refund Policy**
6. **Privacy Policy**
7. **Company name or sole-trader brand in the Terms** — legal name preferred
   for sole traders
8. **HTTPS**

### What we have

`https://ad-interceptor.pages.dev` currently serves **the privacy policy and
nothing else** — `site/index.html` and `site/privacy-policy.html` are
byte-identical copies of it (`scripts/build-site.mjs` writes both from the same
source). That was deliberate: the site existed only to satisfy the Chrome Web
Store's policy-URL requirement.

So against Paddle's list:

- ✅ Privacy Policy
- ✅ HTTPS (Cloudflare Pages)
- ❌ Product description / landing page
- ❌ Pricing page
- ❌ Terms & Conditions
- ❌ Refund Policy

**Four pages have to be written before domain review can pass.** That is the
critical path, and it is ordinary work — no dependency on Paddle, so it can
start now.

### Only submit this domain

Paddle warns that domains carrying unrelated products raise chargeback risk and
get rejected. `ad-interceptor.pages.dev` sells exactly one thing, which is
ideal. Do **not** add the Data Saver listing to it.

---

## Phase 2: business identification

What Paddle wants depends on how you are trading:

- **Sole trader / individual** — ownership documents are **not required**. This
  is the shortest path and, for a one-person extension business, the honest
  description.
- **Registered company** — a shareholder or ownership-breakdown document naming
  every individual or entity holding **more than 25%**, with percentages.

Paddle explicitly does **not** accept:

- utility bills
- accounting documents
- tax identification documents (e.g. an EIN)

as business identification. Sending those is a common source of delay.

---

## Phase 3: identity verification

Handled through Paddle's partner **Sumsub**. Expect to upload a
government-issued ID and a proof of address, and in some cases to complete a
short **liveness check** — a video confirming it is really you.

Have those two documents scanned and to hand before you start, so this does not
stall midway.

---

## Before you submit: check the Acceptable Use Policy

Read [what you're not allowed to sell](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle)
and be ready to describe Pro in one plain sentence.

Ad blocking is a legitimate, widely-sold software category — AdGuard,
AdLock and others sell it commercially — so this is not a borderline product.
Describe it as what it is: **a browser extension that blocks advertising and
trackers, sold as an annual subscription.** Do not describe Pro in terms of
bypassing or circumventing anything; that framing invites questions the product
does not deserve.

---

## One decision only you can make: the price

Paddle needs pricing details, and pricing was discussed but never fixed. You
need a number before the pricing page can exist.

For reference, the category sells at roughly **$10–$30/year** for a single-user
ad blocker. A defensible opening position, given the free tier keeps the full
106,787-rule set permanently:

- **$14.99/year**, one plan, up to 3 devices (which is what the backend already
  enforces).

Annual rather than monthly, because monthly billing on a $1-ish product is
mostly payment fees, and because the Pro promise — daily filter updates — is an
ongoing-maintenance story that reads naturally as a yearly renewal.

---

## Checklist

```
[x] Decide the price                    $14.99/yr, 3 devices
[x] Create the Paddle account           individual category, 2026-09-08
                                        legal name: Ratnesh Kushwaha
                                        website given: ad-interceptor.pages.dev
[x] Write the 4 missing pages           store-listing/web/, built into site/
[ ] Change the Chrome Web Store Privacy policy field to
    https://ad-interceptor.pages.dev/privacy-policy   <-- DO THIS FIRST
[ ] Deploy the site                     npx wrangler pages deploy site --project-name=ad-interceptor
[x] Sandbox catalogue                   product + price + client token, 2026-09-08
                                        see memory: paddle-sandbox-ids
[x] Checkout built                      overlay on /pricing, sandbox mode
[ ] Confirm domain review sees the real pages
[ ] Set the sandbox DEFAULT PAYMENT LINK to https://ad-interceptor.pages.dev/pricing
[ ] Deploy backend/, then set BOTH config.js API_BASE and seller.json apiBase
[ ] Create the sandbox notification destination -> <worker>/v1/paddle/webhook
    (needs the deployed Worker URL, so it comes after the deploy)
[ ] Rotate the sandbox API key (it was pasted into a transcript)
[ ] Business identification (sole trader = no ownership docs needed)
[ ] Identity verification via Sumsub — ID + proof of address ready
[ ] Once approved: deploy backend/ (see backend/README.md)
[ ] Set API_BASE in config.js
[ ] Publish a first filter build
[ ] Build key delivery to buyers
[ ] Flip PRO_ENABLED, add "Authentication information" to the data disclosure
```
