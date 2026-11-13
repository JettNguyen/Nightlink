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

// The database functions the webhook calls, recorded. Sam starts with 5
// credits and a free plan. grant_ai_credits adds a pack once per key, the way
// the real one does.
const fakeSupabase = () => {
  const calls = [];
  const granted = new Set();
  const rows = { [SAM]: { credits: 5, sources: {} } };
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'grant_ai_credits') {
      if (granted.has(args.p_key)) return { data: { granted: false, reason: 'already_granted' }, error: null };
      granted.add(args.p_key);
      if (!rows[args.p_user_id]) return { data: { granted: false, reason: 'no_account' }, error: null };
      rows[args.p_user_id].credits += args.p_amount;
      return { data: { granted: true, creditBalance: rows[args.p_user_id].credits }, error: null };
    }
    if (name === 'set_plan_source') {
      const row = rows[args.p_user_id];
      if (!row) return { data: null, error: null };
      row.sources[args.p_source] = args.p_state;
      return { data: { tier: Object.values(row.sources).some((s) => s.active) ? 'premium' : 'free' }, error: null };
    }
    return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
  };
  return { calls, rows, admin: { rpc } };
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
    assert.equal(supabase.rows[SAM].credits, 15, `${name}: the pack's 10 credits land`);
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

  assert.equal(supabase.calls.length, 0);
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
  assert.equal(supabase.calls.length, 0);
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

const deliver = async (event) => {
  const { payload, header } = sign(event);
  const res = response();
  await stripeRoute(vercelRequest(payload, header), res);
  return res;
};

test('a credit pack is added once, however many times Stripe delivers it', async (t) => {
  const supabase = withFakes(t);
  for (let i = 0; i < 3; i += 1) assert.equal((await deliver(creditPackEvent())).statusCode, 200);
  assert.equal(supabase.rows[SAM].credits, 15);
  const grants = supabase.calls.filter((c) => c.name === 'grant_ai_credits');
  assert.equal(grants.length, 3);
  assert.ok(grants.every((c) => c.args.p_key === 'stripe:cs_test_credit_pack' && c.args.p_source === 'stripe'));
});

test("a checkout that isn't paid yet, or names no account, adds nothing", async (t) => {
  const supabase = withFakes(t);
  await deliver(creditPackEvent({ payment_status: 'unpaid' }));
  // What a payment link sends: no account anywhere on it.
  await deliver(creditPackEvent({ client_reference_id: null, metadata: {} }));
  assert.equal(supabase.calls.length, 0);
  assert.equal(supabase.rows[SAM].credits, 5);
});

const subscriptionEvent = (type, status, { created = 1794583518, uid = SAM } = {}) => ({
  id: `evt_${type}_${status}_${created}`,
  object: 'event',
  type,
  created,
  data: { object: { id: 'sub_test_sam', object: 'subscription', status, customer: 'cus_test_sam', metadata: uid ? { uid } : {} } },
});

test("a website subscription sets the plan's web part from Stripe's status", async (t) => {
  const supabase = withFakes(t);
  const webStates = () => supabase.calls.filter((c) => c.name === 'set_plan_source').map((c) => [c.args.p_source, c.args.p_state.active, c.args.p_state.status]);

  await deliver({
    id: 'evt_checkout_pro',
    object: 'event',
    type: 'checkout.session.completed',
    created: 1794583518,
    data: { object: { id: 'cs_test_pro', object: 'checkout.session', mode: 'subscription', payment_status: 'paid', client_reference_id: SAM, metadata: { uid: SAM } } },
  });
  await deliver(subscriptionEvent('customer.subscription.updated', 'past_due'));
  await deliver(subscriptionEvent('customer.subscription.updated', 'unpaid'));
  await deliver(subscriptionEvent('customer.subscription.deleted', 'canceled'));
  assert.deepEqual(webStates(), [
    ['web', true, 'active'],
    ['web', true, 'past_due'],
    ['web', false, 'unpaid'],
    ['web', false, 'canceled'],
  ]);
  const last = supabase.calls.at(-1).args.p_state;
  assert.equal(last.eventAt, 1794583518000, "Stripe's event time goes along, so an older event can't undo a newer one");
});

test("a checkout still being paid leaves the plan alone, and a subscription with no account is skipped", async (t) => {
  const supabase = withFakes(t);
  await deliver(subscriptionEvent('customer.subscription.created', 'incomplete'));
  await deliver(subscriptionEvent('customer.subscription.updated', 'active', { uid: null }));
  assert.equal(supabase.calls.length, 0);
});

test('a database error makes Stripe try again later', async (t) => {
  withFakes(t);
  t.mock.method(console, 'error', () => {});
  t.mock.method(stripeRoute.deps, 'getSupabaseAdmin', () => ({
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.grant_ai_credits' } }),
  }));
  const res = await deliver(creditPackEvent());
  assert.equal(res.statusCode, 500);
});
