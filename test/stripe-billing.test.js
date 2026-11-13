import { test } from 'node:test';
import assert from 'node:assert/strict';
import stripeRoute from '../api/stripe.js';

// Tests for the plan_status and manage_plan actions in api/stripe.js. They live
// outside api/ because Vercel turns every file in there into an endpoint.

const SAM = { id: '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61' };
const DANA = { id: 'f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42' };
const ELLEN = { id: '0c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6' };
const TOKENS = { 'token-sam': SAM, 'token-dana': DANA, 'token-ellen': ELLEN };

const sub = (uid, customer, extra = {}) => ({
  id: `sub_${customer}_${extra.created || 1}`,
  customer,
  status: 'active',
  cancel_at_period_end: false,
  cancel_at: null,
  created: 1,
  metadata: { uid },
  ...extra,
});

// Stripe as the handler sees it, recording every call.
const fakeStripe = (subscriptions, { portalError, searchReturnsEverything = false } = {}) => {
  const calls = { searches: [], pages: [] };
  return {
    calls,
    subscriptions: {
      search: async ({ query }) => {
        calls.searches.push(query);
        if (searchReturnsEverything) return { data: subscriptions };
        const uid = /^metadata\['uid'\]:'([^']*)'$/.exec(query)?.[1];
        return { data: subscriptions.filter((s) => s.metadata?.uid === uid) };
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          calls.pages.push(params);
          if (portalError) throw portalError;
          return { url: `https://billing.stripe.com/p/session/test_${params.customer}` };
        },
      },
    },
  };
};

// Supabase checks the token: only the tokens above belong to anyone.
const fakeSupabase = () => ({
  auth: {
    getUser: async (token) => (TOKENS[token]
      ? { data: { user: TOKENS[token] }, error: null }
      : { data: { user: null }, error: { status: 401, message: 'invalid JWT' } }),
  },
});

// Mocked once per test. Change `stripe` on what this returns to swap the fake
// mid-test, or set it to an Error to act like a missing key.
const useFakes = (t, stripe) => {
  const current = { stripe };
  t.mock.method(stripeRoute.deps, 'getStripe', () => {
    if (current.stripe instanceof Error) throw current.stripe;
    return current.stripe;
  });
  t.mock.method(stripeRoute.deps, 'getSupabaseAdmin', fakeSupabase);
  return current;
};

const call = async ({ token, authorization, body, origin = 'https://www.nightlink.dev' }) => {
  const headers = { 'content-type': 'application/json', origin };
  if (token) headers.authorization = `Bearer ${token}`;
  if (authorization) headers.authorization = authorization;
  const res = {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  await stripeRoute({ method: 'POST', headers, body }, res);
  return res;
};

// House style for words on screen: no "portal", "session" or "credentials",
// and no en or em dashes.
const ON_SCREEN_WORDS_TO_AVOID = /portal|session|credential|[\u2013\u2014]/i;

test('both actions need a signed-in caller', async (t) => {
  const stripe = fakeStripe([sub(SAM.id, 'cus_sam')]);
  useFakes(t, stripe);

  for (const action of ['manage_plan', 'plan_status']) {
    for (const who of [{}, { token: 'not-a-real-token' }, { authorization: 'token-sam' }, { authorization: 'Basic token-sam' }]) {
      const res = await call({ ...who, body: { action, uid: SAM.id } });
      assert.equal(res.statusCode, 401, `${action} with ${JSON.stringify(who)}`);
      assert.equal(res.body.error, 'Sign in again, then try once more.');
    }
  }
  assert.equal(stripe.calls.searches.length, 0, 'Stripe is never asked without a signed-in caller');
  assert.equal(stripe.calls.pages.length, 0);
});

test('a caller only ever reaches their own customer, whatever the body says', async (t) => {
  const stripe = fakeStripe([sub(SAM.id, 'cus_sam'), sub(DANA.id, 'cus_dana')]);
  useFakes(t, stripe);

  const res = await call({
    token: 'token-sam',
    body: { action: 'manage_plan', uid: DANA.id, customer: 'cus_dana', customerId: 'cus_dana' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://billing.stripe.com/p/session/test_cus_sam');
  assert.deepEqual(stripe.calls.searches, [`metadata['uid']:'${SAM.id}'`]);
  assert.deepEqual(stripe.calls.pages.map((page) => page.customer), ['cus_sam']);

  // Ellen has no plan. Naming Dana's uid or customer doesn't lend her Dana's.
  const ellen = await call({ token: 'token-ellen', body: { action: 'manage_plan', uid: DANA.id, customer: 'cus_dana' } });
  assert.equal(ellen.statusCode, 404);
  const ellenStatus = await call({ token: 'token-ellen', body: { action: 'plan_status', uid: DANA.id } });
  assert.deepEqual(ellenStatus.body, { webPlan: false });
  assert.deepEqual(stripe.calls.pages.map((page) => page.customer), ['cus_sam']);
});

test("a search that returns someone else's subscription still only opens the caller's own", async (t) => {
  const stripe = fakeStripe(
    [sub(DANA.id, 'cus_dana', { created: 9 }), sub(SAM.id, 'cus_sam', { created: 1 }), sub(undefined, 'cus_nobody')],
    { searchReturnsEverything: true },
  );
  useFakes(t, stripe);

  const sam = await call({ token: 'token-sam', body: { action: 'manage_plan' } });
  assert.equal(sam.statusCode, 200);
  assert.deepEqual(stripe.calls.pages.map((page) => page.customer), ['cus_sam']);

  const ellen = await call({ token: 'token-ellen', body: { action: 'manage_plan' } });
  assert.equal(ellen.statusCode, 404);
  assert.equal(stripe.calls.pages.length, 1);
});

test('no plan bought on the website gives a clear message that says what to do', async (t) => {
  const stripe = fakeStripe([sub(SAM.id, 'cus_sam')]);
  useFakes(t, stripe);

  const res = await call({ token: 'token-ellen', body: { action: 'manage_plan' } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'no_web_plan');
  assert.match(res.body.error, /couldn't find a plan bought on nightlink\.dev/);
  assert.match(res.body.error, /open the Settings app, tap your name, then Subscriptions/);
  assert.match(res.body.error, /support@nightlink\.dev/);
  assert.doesNotMatch(res.body.error, ON_SCREEN_WORDS_TO_AVOID);
  assert.equal(stripe.calls.pages.length, 0);

  const status = await call({ token: 'token-ellen', body: { action: 'plan_status' } });
  assert.deepEqual(status.body, { webPlan: false });
});

test('the plan still renewing wins, and plan_status counts only a plan that is still going', async (t) => {
  const stripe = fakeStripe([
    sub(SAM.id, 'cus_sam_old', { status: 'canceled', created: 30 }),
    sub(SAM.id, 'cus_sam_ending', { cancel_at_period_end: true, created: 20 }),
    sub(SAM.id, 'cus_sam_renewing', { created: 10 }),
    sub(DANA.id, 'cus_dana_old', { status: 'canceled', created: 5 }),
    sub(DANA.id, 'cus_dana_older', { status: 'incomplete_expired', created: 4 }),
  ]);
  useFakes(t, stripe);

  const sam = await call({ token: 'token-sam', body: { action: 'manage_plan' } });
  assert.equal(stripe.calls.pages.at(-1).customer, 'cus_sam_renewing');
  assert.equal(sam.statusCode, 200);
  assert.deepEqual((await call({ token: 'token-sam', body: { action: 'plan_status' } })).body, { webPlan: true });

  // Dana's plans have all ended. Stripe's page still opens, for her past payments,
  // but Settings doesn't offer it.
  const dana = await call({ token: 'token-dana', body: { action: 'manage_plan' } });
  assert.equal(dana.statusCode, 200);
  assert.equal(stripe.calls.pages.at(-1).customer, 'cus_dana_old');
  assert.deepEqual((await call({ token: 'token-dana', body: { action: 'plan_status' } })).body, { webPlan: false });
});

test('a plan set to end, or behind on payment, still counts as going', async (t) => {
  const current = useFakes(t, null);
  for (const extra of [{ cancel_at_period_end: true }, { cancel_at: 1893456000 }, { status: 'past_due' }, { status: 'trialing' }]) {
    current.stripe = fakeStripe([sub(SAM.id, 'cus_sam', extra)]);
    const res = await call({ token: 'token-sam', body: { action: 'plan_status' } });
    assert.deepEqual(res.body, { webPlan: true }, JSON.stringify(extra));
  }
});

test('Stripe sends people back to Settings on this site, never to a site the request names', async (t) => {
  const stripe = fakeStripe([sub(SAM.id, 'cus_sam')]);
  useFakes(t, stripe);

  const backTo = async (origin) => {
    await call({ token: 'token-sam', origin, body: { action: 'manage_plan', returnUrl: 'https://evil.example' } });
    return stripe.calls.pages.at(-1).return_url;
  };
  assert.equal(await backTo('https://www.nightlink.dev'), 'https://www.nightlink.dev/settings');
  assert.equal(await backTo('https://nightlink.dev'), 'https://nightlink.dev/settings');
  assert.equal(await backTo('http://localhost:3000'), 'http://localhost:3000/settings');
  assert.equal(await backTo('https://evil.example'), 'https://www.nightlink.dev/settings');
  assert.equal(await backTo('https://nightlink.dev.evil.example'), 'https://www.nightlink.dev/settings');
  assert.equal(await backTo(''), 'https://www.nightlink.dev/settings');
});

test("when Stripe's billing page isn't turned on, the message says to write to support", async (t) => {
  const off = Object.assign(new Error(
    'No configuration provided and your test mode default configuration has not been created. Provide a '
    + 'configuration or create your default by saving your customer portal settings in test mode at '
    + 'https://dashboard.stripe.com/test/settings/billing/portal.',
  ), { type: 'StripeInvalidRequestError' });
  const stripe = fakeStripe([sub(SAM.id, 'cus_sam')], { portalError: off });
  useFakes(t, stripe);
  const logged = t.mock.method(console, 'error', () => {});

  const res = await call({ token: 'token-sam', body: { action: 'manage_plan' } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'billing_page_off');
  assert.match(res.body.error, /support@nightlink\.dev/);
  assert.doesNotMatch(res.body.error, ON_SCREEN_WORDS_TO_AVOID);
  assert.match(String(logged.mock.calls[0].arguments[1]), /settings\/billing\/portal/, 'the log says where to turn it on');
});

test('Stripe failing or missing its key gives a message with a next step', async (t) => {
  t.mock.method(console, 'error', () => {});

  const broken = fakeStripe([sub(SAM.id, 'cus_sam')], { portalError: Object.assign(new Error('boom'), { type: 'StripeAPIError' }) });
  const current = useFakes(t, broken);
  const failed = await call({ token: 'token-sam', body: { action: 'manage_plan' } });
  assert.equal(failed.statusCode, 502);
  assert.match(failed.body.error, /Try again in a minute/);
  assert.match(failed.body.error, /support@nightlink\.dev/);

  current.stripe = new Error('Neither apiKey nor config.authenticator provided');
  const noKey = await call({ token: 'token-sam', body: { action: 'manage_plan' } });
  assert.equal(noKey.statusCode, 503);
  assert.match(noKey.body.error, /support@nightlink\.dev/);
  assert.doesNotMatch(noKey.body.error, ON_SCREEN_WORDS_TO_AVOID);
});
