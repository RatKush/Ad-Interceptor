#!/usr/bin/env node
/**
 * Apply the regional pricing table to a Paddle price, then verify it.
 *
 * Usage:
 *   PADDLE_API_KEY=... node scripts/paddle-pricing.mjs <price_id> [--live] [--verify-only]
 *
 * WHY THIS IS A SCRIPT
 * Sandbox and live are separate accounts with separate price ids, so this
 * table has to be applied twice. Twenty-five overrides entered by hand on the
 * live account — the one that takes real money — is exactly the kind of
 * repetitive work that produces a 100x pricing error nobody notices until a
 * customer complains.
 *
 * THE DECIMAL TRAP
 * Paddle takes amounts in the currency's LOWEST denomination. Most currencies
 * are 2-decimal (14.99 -> "1499"), but JPY and KRW are zero-decimal
 * (2200 -> "2200"). Getting that wrong does NOT error — it silently prices
 * 100x off. Hence `decimals` is explicit on every row, and hence the verify
 * pass at the end asks Paddle what a buyer would actually be charged rather
 * than trusting the arithmetic here.
 */
const KEY = process.env.PADDLE_API_KEY;
const priceId = process.argv[2];
const live = process.argv.includes('--live');
const verifyOnly = process.argv.includes('--verify-only');

if (!KEY || !priceId) {
  console.error('usage: PADDLE_API_KEY=... node scripts/paddle-pricing.mjs <price_id> [--live] [--verify-only]');
  process.exit(2);
}
if (!/^pri_[a-z0-9]{26}$/.test(priceId)) {
  console.error(`Not a Paddle price id: ${priceId}`);
  process.exit(2);
}

const BASE = live ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';

// Live keys start pdl_live_, sandbox pdl_sdbx_. Crossing them would edit the
// wrong catalogue, so refuse rather than guess.
if (live && !KEY.startsWith('pdl_live_')) {
  console.error('Refusing: --live given but the API key is not a live key.');
  process.exit(1);
}
if (!live && !KEY.startsWith('pdl_sdbx_')) {
  console.error('Refusing: no --live given but the API key is not a sandbox key.');
  process.exit(1);
}

const EURO = ['AT','BE','CY','EE','FI','FR','DE','GR','IE','IT','LV','LT','LU','MT','NL','PT','SK','SI','ES','HR'];

// tier: 'par'  = full price for a high-income market
//       'ppp'  = reduced against local price levels
//
// These are round numbers chosen to read as deliberate local prices, based on
// approximate relative price levels — NOT looked-up official PPP tables.
// Adjust freely; the verify pass will confirm whatever you set.
const TABLE = [
  { cur: 'EUR', amount: 14.99, decimals: 2, countries: EURO,   tier: 'par' },
  { cur: 'GBP', amount: 12.99, decimals: 2, countries: ['GB'], tier: 'par' },
  { cur: 'CHF', amount: 13.99, decimals: 2, countries: ['CH'], tier: 'par' },
  { cur: 'CAD', amount: 19.99, decimals: 2, countries: ['CA'], tier: 'par' },
  { cur: 'AUD', amount: 22.99, decimals: 2, countries: ['AU'], tier: 'par' },
  { cur: 'NZD', amount: 24.99, decimals: 2, countries: ['NZ'], tier: 'par' },
  { cur: 'SGD', amount: 19.99, decimals: 2, countries: ['SG'], tier: 'par' },
  { cur: 'HKD', amount: 115,   decimals: 2, countries: ['HK'], tier: 'par' },
  { cur: 'SEK', amount: 159,   decimals: 2, countries: ['SE'], tier: 'par' },
  { cur: 'NOK', amount: 159,   decimals: 2, countries: ['NO'], tier: 'par' },
  { cur: 'DKK', amount: 105,   decimals: 2, countries: ['DK'], tier: 'par' },
  { cur: 'ILS', amount: 54,    decimals: 2, countries: ['IL'], tier: 'par' },
  { cur: 'JPY', amount: 2200,  decimals: 0, countries: ['JP'], tier: 'par' },
  { cur: 'KRW', amount: 19000, decimals: 0, countries: ['KR'], tier: 'par' },
  { cur: 'TWD', amount: 469,   decimals: 2, countries: ['TW'], tier: 'par' },

  { cur: 'PLN', amount: 39,    decimals: 2, countries: ['PL'], tier: 'ppp' },
  { cur: 'CZK', amount: 219,   decimals: 2, countries: ['CZ'], tier: 'ppp' },
  { cur: 'MXN', amount: 149,   decimals: 2, countries: ['MX'], tier: 'ppp' },
  { cur: 'BRL', amount: 39,    decimals: 2, countries: ['BR'], tier: 'ppp' },
  { cur: 'ZAR', amount: 129,   decimals: 2, countries: ['ZA'], tier: 'ppp' },
  { cur: 'THB', amount: 199,   decimals: 2, countries: ['TH'], tier: 'ppp' },
  { cur: 'CNY', amount: 45,    decimals: 2, countries: ['CN'], tier: 'ppp' },
  { cur: 'TRY', amount: 199,   decimals: 2, countries: ['TR'], tier: 'ppp' },
  { cur: 'UAH', amount: 249,   decimals: 2, countries: ['UA'], tier: 'ppp' },
  // India is priced to unlock UPI, which Paddle only offers on INR prices to
  // customers in India. Recurring UPI checkouts must total under 15,000 INR.
  { cur: 'INR', amount: 499,   decimals: 2, countries: ['IN'], tier: 'ppp' }
];

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

// A country must appear in at most one override, or Paddle rejects the batch.
const seen = new Map();
for (const row of TABLE) {
  for (const c of row.countries) {
    if (seen.has(c)) {
      console.error(`Country ${c} appears in both ${seen.get(c)} and ${row.cur}.`);
      process.exit(1);
    }
    seen.set(c, row.cur);
  }
}

if (!verifyOnly) {
  const unit_price_overrides = TABLE.map((r) => ({
    country_codes: r.countries,
    unit_price: {
      amount: String(Math.round(r.amount * 10 ** r.decimals)),
      currency_code: r.cur
    }
  }));

  const { status, body } = await call('PATCH', `/prices/${priceId}`, { unit_price_overrides });
  if (status >= 300) {
    console.error(`PATCH failed (${status}):`, JSON.stringify(body.error ?? body, null, 2).slice(0, 1000));
    process.exit(1);
  }
  console.log(`Applied ${unit_price_overrides.length} overrides to ${priceId} (${live ? 'LIVE' : 'sandbox'})`);
  console.log(`  base price: ${body.data.unit_price.amount} ${body.data.unit_price.currency_code}\n`);
}

// --- verify: ask Paddle what a buyer in each market is actually charged ----
// This is the only check that catches a decimals mistake, because a wrong
// denomination is a valid request that stores a wrong number.
console.log('Verifying against Paddle pricing-preview:\n');
console.log(`  ${'ctry'.padEnd(6)}${'cur'.padEnd(6)}${'tier'.padEnd(6)}${'buyer pays'.padStart(13)}   ${'net + tax'.padEnd(22)} payment methods`);
console.log('  ' + '-'.repeat(96));

let failures = 0;
const probes = [{ cc: 'US', cur: 'USD', tier: 'base' }, ...TABLE.map((r) => ({ cc: r.countries[0], cur: r.cur, tier: r.tier }))];

for (const p of probes) {
  const { status, body } = await call('POST', '/pricing-preview', {
    items: [{ price_id: priceId, quantity: 1 }],
    address: { country_code: p.cc }
  });
  if (status >= 300) {
    console.log(`  ${p.cc.padEnd(6)}${p.cur.padEnd(6)}${p.tier.padEnd(6)}${('ERR ' + status).padStart(14)}`);
    failures++;
    continue;
  }
  const item = body.data.details.line_items[0];
  const total = item.formatted_totals.total;
  const net = item.formatted_totals.subtotal;
  const tax = item.formatted_totals.tax;

  // The resolved buyer currency is on `data`, NOT on the line item — the
  // item's price.unit_price.currency_code is the BASE currency and is always
  // USD regardless of which override applied. Asserting on that field made
  // every market look wrong.
  const got = body.data.currency_code;
  const methods = (body.data.available_payment_methods ?? []).join(',') || '(none)';

  // Tax handling differs by market: in tax-inclusive jurisdictions (EU, JP)
  // the override IS the final price and tax is backed out of it; in
  // tax-exclusive ones (US, CA) tax is added on top. So total can legitimately
  // exceed the override. Currency is the hard assertion; net/tax are printed
  // so the treatment is visible rather than surprising.
  const flag = got === p.cur ? ' ' : '!';
  if (flag === '!') failures++;
  console.log(`  ${p.cc.padEnd(6)}${p.cur.padEnd(6)}${p.tier.padEnd(6)}${total.padStart(13)} ${flag} ${(net + ' + ' + tax + ' tax').padEnd(22)} ${methods}`);
}

console.log('');
if (failures) {
  console.error(`${failures} market(s) did not resolve to the expected currency.`);
  process.exit(1);
}
console.log('All markets resolved to the expected currency.');
console.log('NOTE: totals include tax where applicable, so they can exceed the override.');
