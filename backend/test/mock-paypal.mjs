// A stand-in PayPal for local testing of the one-time checkout.
//
// Implements just the calls src/paypal.js makes — OAuth, create order,
// capture (with PayPal's idempotency and ORDER_ALREADY_CAPTURED), get order,
// webhook verification — plus a fake approval page at /checkoutnow that a
// browser (or a test) can "pay" on. Point a NON-live Worker at it with
// PAYPAL_API_BASE; src/paypal.js ignores that variable when PAYPAL_ENV is live.
//
//   import { startMockPayPal } from './mock-paypal.mjs';
//   const mock = await startMockPayPal(8795);

import http from 'node:http';
import { pathToFileURL } from 'node:url';

export async function startMockPayPal(port = 8795) {
  const orders = new Map();         // id -> order
  const captureReplies = new Map(); // PayPal-Request-Id -> reply
  const state = { captures: 0, amountOverride: null, lastCreate: null };
  let seq = 0;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => resolve(d));
  });

  const capturedBody = (o) => ({
    id: o.id,
    status: 'COMPLETED',
    payer: { email_address: 'buyer@example.com', payer_id: 'MOCKPAYER1' },
    purchase_units: [{
      reference_id: o.unit.reference_id,
      payments: {
        captures: [{
          id: o.captureId,
          status: 'COMPLETED',
          custom_id: o.unit.custom_id,
          amount: { currency_code: o.unit.amount.currency_code, value: o.paidValue }
        }]
      }
    }]
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname;

    if (p === '/v1/oauth2/token') return send(res, 200, { access_token: 'mock-token', expires_in: 32400 });

    if (p === '/v1/notifications/verify-webhook-signature') {
      return send(res, 200, { verification_status: 'SUCCESS' });
    }

    if (p === '/v2/checkout/orders' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      state.lastCreate = body;
      // Unique across restarts, like PayPal's own ids.
      const id = `MOCK${Date.now().toString(36).toUpperCase()}${String(++seq).padStart(3, '0')}`;
      const ctx = body.payment_source?.paypal?.experience_context ?? {};
      orders.set(id, {
        id, status: 'PAYER_ACTION_REQUIRED', unit: body.purchase_units[0],
        returnUrl: ctx.return_url, cancelUrl: ctx.cancel_url, landingPage: ctx.landing_page,
        captureId: `CAP${id}`, paidValue: null
      });
      return send(res, 201, {
        id, status: 'PAYER_ACTION_REQUIRED',
        links: [{ rel: 'payer-action', href: `http://127.0.0.1:${port}/checkoutnow?token=${id}` }]
      });
    }

    // The fake approval page. ?action=pay|cancel skips the buttons (for API tests).
    if (p === '/checkoutnow') {
      const o = orders.get(url.searchParams.get('token'));
      if (!o) return send(res, 404, { error: 'no such order' });
      const action = url.searchParams.get('action');
      if (action === 'pay') {
        o.status = 'APPROVED';
        res.writeHead(302, { Location: `${o.returnUrl}?token=${o.id}&PayerID=MOCKPAYER1` });
        return res.end();
      }
      if (action === 'cancel') {
        res.writeHead(302, { Location: `${o.cancelUrl}&token=${o.id}` });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><title>Mock PayPal</title>
        <h1>Mock PayPal checkout</h1>
        <p id="landing">landing_page: ${o.landingPage}</p>
        <p>Pay ${o.unit.amount.value} ${o.unit.amount.currency_code} — ${o.unit.description}</p>
        <a id="payCard" href="?token=${o.id}&action=pay">Pay with Debit or Credit Card</a>
        <a id="cancel" href="?token=${o.id}&action=cancel">Cancel and return</a>`);
    }

    const cap = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (cap && req.method === 'POST') {
      const o = orders.get(cap[1]);
      if (!o) return send(res, 404, { name: 'RESOURCE_NOT_FOUND' });
      const rid = req.headers['paypal-request-id'];
      if (rid && captureReplies.has(rid)) return send(res, 201, captureReplies.get(rid));
      if (o.status === 'COMPLETED') {
        return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      }
      if (o.status !== 'APPROVED') {
        return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
      }
      o.status = 'COMPLETED';
      o.paidValue = state.amountOverride ?? o.unit.amount.value;
      state.captures++;
      const reply = capturedBody(o);
      if (rid) captureReplies.set(rid, reply);
      return send(res, 201, reply);
    }

    const get = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/);
    if (get && req.method === 'GET') {
      const o = orders.get(get[1]);
      if (!o) return send(res, 404, { name: 'RESOURCE_NOT_FOUND' });
      return send(res, 200, o.status === 'COMPLETED' ? capturedBody(o) : { id: o.id, status: o.status });
    }

    send(res, 404, { error: `mock has no ${req.method} ${p}` });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    state, orders,
    /** Approve an order the way a buyer would, without a browser. */
    approve: (id) => { const o = orders.get(id); if (o) o.status = 'APPROVED'; return o; },
    close: () => new Promise((r) => server.close(r))
  };
}

// Run standalone for browser tests: node test/mock-paypal.mjs [port]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 8795);
  await startMockPayPal(port);
  console.log(`mock PayPal on http://127.0.0.1:${port}`);
}
