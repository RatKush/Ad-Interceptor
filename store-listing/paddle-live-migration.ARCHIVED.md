# Sandbox → live migration record

Migrated 2026-09-09. Sandbox and live are entirely separate accounts; **IDs
never cross environments**, so every ID below had to be recreated, not copied.

| Entity | Sandbox | Live |
|---|---|---|
| Product | `pro_01m20bdrndr7cqbgwdk7dagr0k` | `pro_01m22n7webmw587z1syexh45ba` |
| Price (annual) | `pri_01m20bds6896n4e1ym7zb45ne2` | `pri_01m22n7wm9vyy45jes3bkytmer` |
| Client token | `test_9c6301ae6f9cb0873a0941240df` | `live_f38fb41746c53acd30f5a7993fc` |
| Notification destination | `ntfset_01m20x88gff250stnh8ttfkwy2` | `ntfset_01m22n8pp021kh9nyg88eyshtb` |
| Discounts | none | none |

Both prices carry the same 25 regional overrides, `tax_mode: location`,
quantity 1–1, and `tax_category: standard` (pre-written software installed on
a local device — a browser extension is that, not `saas`).

## What is NOT migrated, and cannot be

- **The webhook signing secret.** Each destination has its own. Copy the live
  one from Paddle > Developer tools > Notifications and set it with
  `cd backend && npx wrangler secret put PADDLE_WEBHOOK_SECRET`. Never paste
  it into a chat or a file in this repo.
- **Customers, subscriptions and transactions.** Sandbox test purchases have
  no live equivalent and should not be recreated.

## The deploy gate

`store-listing/web/seller.json` is now `production`, so a build carries live
config. **The site has NOT been deployed with it.** Production still serves the
sandbox build. Do not deploy until:

1. `ad-interceptor.pages.dev` is **approved** under Paddle > Checkout >
   Website approval (live does not auto-approve; sandbox did), and
2. account verification has passed.

Deploying earlier puts a live checkout on an unapproved domain: Paddle.js
fails to load and every visitor who clicks Get Pro sees "Something went
wrong". `npm run site` prints a warning to that effect.

## Rolling back to sandbox

Set `paddleEnvironment` to `sandbox` and restore the `test_`/sandbox `pri_`
values from the table above. Nothing else is environment-specific — the
`Environment.set('sandbox')` call is already conditional, and the Worker never
calls the Paddle API, only verifies webhook signatures.
