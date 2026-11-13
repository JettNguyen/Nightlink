import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import Stripe from 'stripe';
import stripeRoute from '../api/stripe.js';

// Stripe's webhook, fed payloads signed here with Stripe's own test helper and
// a made-up secret. Nothing reaches Stripe or Supabase.

const SECRET = 'whsec_made_up_for_these_tests';
const SAM = '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61';

// A credit pack checkout the way Stripe sends it: indented JSON. That indent is
// what JSON.stringify(req.body) used to lose, failing every event.
const creditPackEvent = (overrides = {}) => ({
  id: 'evt_test_credit_pack',
  object: 'event',
  type: 'checkout.session.completed',
  created: 1794583518,
  data: {
    object: {
      id: 'cs_test_credit_pack',
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'paid',
      client_reference_id: SAM,
      metadata: { uid: SAM },
      ...overrides,
    },
  },
});

const sign = (event, secret = SECRET) => {
  const payload = JSON.stringify(event, null, 2);
  return { payload, header: Stripe.webhooks.generateTestHeaderString({ payload, secret }) };
};

// The Supabase calls the webhook makes, recorded. Sam starts with 5 credits.
const fakeSupabase = () => {
  const updates = [];
  const rows = { [SAM]: { ai_usage: { monthYear: '2026-11', monthlyCount: 1, creditBalance: 5 }, subscription: { tier: 'free' } } };
  const from = (table) => {
    let id;
    let patch;
    const builder = {
      select() { return builder; },
      update(values) { patch = values; return builder; },
      eq(_column, value) {
        id = value;
        if (patch) {
          updates.push({ table, id, patch });
          rows[id] = { ...rows[id], ...patch };
          return Promise.resolve({ error: null });
        }
        return builder;
      },
      single: async () => ({ data: rows[id] || null, error: null }),
    };
    return builder;
  };
  return { updates, rows, admin: { from } };
};

const withFakes = (t) => {
  const supabase = fakeSupabase();
  t.mock.method(stripeRoute.deps, 'getSupabaseAdmin', () => supabase.admin);
  t.mock.method(stripeRoute.deps, 'getStripe', () => { throw new Error('the webhook needs no API key'); });
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  t.after(() => { delete process.env.STRIPE_WEBHOOK_SECRET; });
  t.mock.method(console, 'log', () => {});
  return supabase;
};

const response = () => ({
  statusCode: 200,
  body: undefined,
  setHeader() {},
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
  end() { return this; },
});

const headersFor = (header) => ({
  'content-type': 'application/json; charset=utf-8',
  'stripe-signature': header,
});

// How Vercel hands a request over: it has read the body already, parses it
// into req.body when asked, and plays the same bytes back on 'data' and 'end'.
// Counts every read of req.body.
const vercelRequest = (payload, header) => {
  const replay = new PassThrough();
  replay.end(Buffer.from(payload));
  const req = {
    method: 'POST',
    headers: headersFor(header),
    bodyReads: 0,
    on(name, cb) { replay.on(name, cb); return req; },
  };
  Object.defineProperty(req, 'body', {
    get() { req.bodyReads += 1; return JSON.parse(payload); },
  });
  return req;
};

// The local dev server: express.json has read the stream, parsed req.body and
// kept the bytes on req.rawBody.
const devServerRequest = (payload, header) => ({
  method: 'POST',
  headers: headersFor(header),
  body: JSON.parse(payload),
  rawBody: Buffer.from(payload),
});

// A plain Node request nobody has read yet, in two chunks.
const streamRequest = (payload, header) => {
  const half = Math.floor(payload.length / 2);
  return Object.assign(Readable.from([Buffer.from(payload.slice(0, half)), Buffer.from(payload.slice(half))]), {
    method: 'POST',
    headers: headersFor(header),
  });
};

test("a webhook Stripe signed is accepted from its raw bytes, however they're handed over", async (t) => {
  for (const [name, makeRequest] of [['Vercel', vercelRequest], ['dev server', devServerRequest], ['plain stream', streamRequest]]) {
    const supabase = withFakes(t);
    const { payload, header } = sign(creditPackEvent());
    const req = makeRequest(payload, header);
    const res = response();
    await stripeRoute(req, res);

    assert.equal(res.statusCode, 200, `${name}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { received: true });
    assert.equal(supabase.rows[SAM].ai_usage.creditBalance, 15, `${name}: the pack's 10 credits land`);
    if (name === 'Vercel') assert.equal(req.bodyReads, 0, 'nothing reads req.body on the webhook path');
  }
});

test('re-serializing the parsed body, the old way, fails the same signature', () => {
  const { payload, header } = sign(creditPackEvent());
  assert.throws(
    () => Stripe.webhooks.constructEvent(JSON.stringify(JSON.parse(payload)), header, SECRET),
    { type: 'StripeSignatureVerificationError' },
  );
  assert.doesNotThrow(() => Stripe.webhooks.constructEvent(Buffer.from(payload), header, SECRET));
});

test('a changed byte, another secret or no signature is turned away and changes nothing', async (t) => {
  const supabase = withFakes(t);
  t.mock.method(console, 'error', () => {});

  const { payload, header } = sign(creditPackEvent());
  const tampered = payload.replace('"payment_status": "paid"', '"payment_status": "paid" ');
  const res = response();
  await stripeRoute(vercelRequest(tampered, header), res);
  assert.equal(res.statusCode, 400);

  const other = sign(creditPackEvent(), 'whsec_someone_else');
  const res2 = response();
  await stripeRoute(vercelRequest(other.payload, other.header), res2);
  assert.equal(res2.statusCode, 400);

  // Without the header it isn't a webhook at all, so it's an unknown action.
  const res3 = response();
  await stripeRoute({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.parse(payload) }, res3);
  assert.equal(res3.statusCode, 400);

  assert.equal(supabase.updates.length, 0);
});

test('without STRIPE_WEBHOOK_SECRET the webhook refuses and the log says which setting', async (t) => {
  const supabase = withFakes(t);
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const logged = t.mock.method(console, 'error', () => {});

  const { payload, header } = sign(creditPackEvent());
  const res = response();
  await stripeRoute(vercelRequest(payload, header), res);
  assert.equal(res.statusCode, 500);
  assert.match(String(logged.mock.calls[0].arguments[0]), /STRIPE_WEBHOOK_SECRET/);
  assert.equal(supabase.updates.length, 0);
});

test('a body that never arrives is given up on instead of held open', async (t) => {
  withFakes(t);
  t.mock.method(console, 'error', () => {});
  const wait = stripeRoute.deps.rawBodyWaitMs;
  stripeRoute.deps.rawBodyWaitMs = 20;
  t.after(() => { stripeRoute.deps.rawBodyWaitMs = wait; });

  const { header } = sign(creditPackEvent());
  const silent = { method: 'POST', headers: headersFor(header), on() { return silent; } };
  const res = response();
  await stripeRoute(silent, res);
  assert.equal(res.statusCode, 400);
});
