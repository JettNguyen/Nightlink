import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import stripeRoute from '../api/stripe.js';

// create_checkout: every purchase on the website goes through it, so the plan
// or the credits land on the account that paid. Stripe is a fake here.

const SAM = { id: '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61' };
const DANA = { id: 'f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42' };
const TOKENS = { 'token-sam': SAM, 'token-dana': DANA };

const PRO_PRICE = 'price_test_pro_monthly';
const CREDIT_PRICE = 'price_test_ten_credits';

const fakeStripe = ({ fail } = {}) => {
  const created = [];
  return {
    created,
    checkout: {
      sessions: {
        create: async (params) => {
          if (fail) throw fail;
          created.push(params);
          return { url: `https://checkout.stripe.com/c/pay/cs_test_${created.length}` };
        },
      },
    },
  };
};

const fakeSupabase = () => ({
  auth: {
    getUser: async (token) => (TOKENS[token]
      ? { data: { user: TOKENS[token] }, error: null }
      : { data: { user: null }, error: { status: 401, message: 'invalid JWT' } }),
  },
});

const PRICE_SETTINGS = ['STRIPE_PREMIUM_PRICE_ID', 'STRIPE_CREDIT_PRICE_ID', 'VITE_STRIPE_PREMIUM_PRICE_ID', 'VITE_STRIPE_CREDIT_PRICE_ID'];

const withFakes = (t, stripe, prices = { STRIPE_PREMIUM_PRICE_ID: PRO_PRICE, STRIPE_CREDIT_PRICE_ID: CREDIT_PRICE }) => {
  const saved = Object.fromEntries(PRICE_SETTINGS.map((name) => [name, process.env[name]]));
  for (const name of PRICE_SETTINGS) delete process.env[name];
  Object.assign(process.env, prices);
  t.after(() => {
    for (const name of PRICE_SETTINGS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  t.mock.method(stripeRoute.deps, 'getStripe', () => {
    if (stripe instanceof Error) throw stripe;
    return stripe;
  });
  t.mock.method(stripeRoute.deps, 'getSupabaseAdmin', fakeSupabase);
};

const checkout = async ({ token, body, origin = 'https://www.nightlink.dev' }) => {
  const headers = { 'content-type': 'application/json', origin };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  await stripeRoute({ method: 'POST', headers, body: { action: 'create_checkout', ...body } }, res);
  return res;
};

const ON_SCREEN_WORDS_TO_AVOID = /portal|session|credential|configure|[\u2013\u2014]/i;

test("Subscribe to Pro opens a checkout that carries the caller's account onto the subscription", async (t) => {
  const stripe = fakeStripe();
  withFakes(t, stripe);

  const res = await checkout({ token: 'token-sam', body: { plan: 'pro' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const [params] = stripe.created;
  assert.equal(params.mode, 'subscription');
  assert.deepEqual(params.line_items, [{ price: PRO_PRICE, quantity: 1 }]);
  assert.equal(params.client_reference_id, SAM.id);
  assert.equal(params.metadata.uid, SAM.id);
  assert.deepEqual(params.subscription_data, { metadata: { uid: SAM.id } });
});

test('ten credits are a one-time payment tied to the account', async (t) => {
  const stripe = fakeStripe();
  withFakes(t, stripe);

  const res = await checkout({ token: 'token-dana', body: { plan: 'credits' } });
  assert.equal(res.statusCode, 200);
  const [params] = stripe.created;
  assert.equal(params.mode, 'payment');
  assert.deepEqual(params.line_items, [{ price: CREDIT_PRICE, quantity: 1 }]);
  assert.equal(params.client_reference_id, DANA.id);
  assert.equal(params.metadata.uid, DANA.id);
  assert.equal(params.subscription_data, undefined);
});

test("the request can't pick the price, the mode or someone else's account", async (t) => {
  const stripe = fakeStripe();
  withFakes(t, stripe);

  // Pages from before this change send a price and a mode. The price must be
  // one of ours, and the mode comes from it, not from the request.
  const legacy = await checkout({ token: 'token-sam', body: { uid: SAM.id, priceId: PRO_PRICE, mode: 'payment' } });
  assert.equal(legacy.statusCode, 200);
  assert.equal(stripe.created.at(-1).mode, 'subscription');

  const otherPrice = await checkout({ token: 'token-sam', body: { priceId: 'price_one_cent', mode: 'subscription' } });
  assert.equal(otherPrice.statusCode, 400);
  assert.doesNotMatch(otherPrice.body.error, ON_SCREEN_WORDS_TO_AVOID);

  const unknownPlan = await checkout({ token: 'token-sam', body: { plan: 'toString' } });
  assert.equal(unknownPlan.statusCode, 400);

  // Sam's token with Dana's uid in the body: refused rather than bought for either.
  const someoneElse = await checkout({ token: 'token-sam', body: { plan: 'pro', uid: DANA.id } });
  assert.equal(someoneElse.statusCode, 401);

  const signedOut = await checkout({ body: { plan: 'pro', uid: SAM.id } });
  assert.equal(signedOut.statusCode, 401);
  assert.equal(signedOut.body.error, 'Sign in again, then try once more.');

  assert.equal(stripe.created.length, 1, 'only the legacy request reached Stripe');
});

test('the price comes from STRIPE_PREMIUM_PRICE_ID, or the VITE_ setting older deploys have', async (t) => {
  const stripe = fakeStripe();
  withFakes(t, stripe, { VITE_STRIPE_PREMIUM_PRICE_ID: 'price_from_vite_setting' });

  const res = await checkout({ token: 'token-sam', body: { plan: 'pro' } });
  assert.equal(res.statusCode, 200);
  assert.equal(stripe.created[0].line_items[0].price, 'price_from_vite_setting');
});

test('success and cancel bring people back to Settings on this site only', async (t) => {
  const stripe = fakeStripe();
  withFakes(t, stripe);

  const backTo = async (origin, extra = {}) => {
    await checkout({ token: 'token-sam', origin, body: { plan: 'pro', ...extra } });
    const { success_url: success, cancel_url: cancel } = stripe.created.at(-1);
    return [success, cancel];
  };
  assert.deepEqual(await backTo('https://www.nightlink.dev'), [
    'https://www.nightlink.dev/settings?payment=success',
    'https://www.nightlink.dev/settings?payment=cancelled',
  ]);
  assert.deepEqual(await backTo('http://localhost:3000'), [
    'http://localhost:3000/settings?payment=success',
    'http://localhost:3000/settings?payment=cancelled',
  ]);
  const [success] = await backTo('https://evil.example', { successUrl: 'https://evil.example/thanks' });
  assert.equal(success, 'https://www.nightlink.dev/settings?payment=success');
});

test('with no price set, the message says what to do', async (t) => {
  t.mock.method(console, 'error', () => {});

  withFakes(t, fakeStripe(), {});
  const noPrice = await checkout({ token: 'token-sam', body: { plan: 'pro' } });
  assert.equal(noPrice.statusCode, 503);
  assert.match(noPrice.body.error, /support@nightlink\.dev/);
  assert.doesNotMatch(noPrice.body.error, ON_SCREEN_WORDS_TO_AVOID);
});

test('a missing key or a Stripe error gives a message that says what to do', async (t) => {
  t.mock.method(console, 'error', () => {});

  withFakes(t, new Error('Neither apiKey nor config.authenticator provided'));
  const noKey = await checkout({ token: 'token-sam', body: { plan: 'pro' } });
  assert.equal(noKey.statusCode, 503);
  assert.match(noKey.body.error, /support@nightlink\.dev/);
});

test('Stripe failing mid-checkout gives a message that says what to do', async (t) => {
  t.mock.method(console, 'error', () => {});

  withFakes(t, fakeStripe({ fail: Object.assign(new Error('boom'), { type: 'StripeAPIError' }) }));
  const failed = await checkout({ token: 'token-sam', body: { plan: 'credits' } });
  assert.equal(failed.statusCode, 502);
  assert.match(failed.body.error, /Try again in a minute/);
  assert.doesNotMatch(failed.body.error, ON_SCREEN_WORDS_TO_AVOID);
});

// Payment links can't carry the account, so the website must not use them, and
// it no longer needs any Stripe setting in its bundle.
test('the website reads no Stripe payment link or price', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(js|jsx)$/.test(name)) files.push(path);
    }
  };
  walk(new URL('../src', import.meta.url).pathname);
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /VITE_STRIPE_(PREMIUM|CREDIT)_(LINK|PRICE_ID)/, file);
  }
});
