import { test } from 'node:test';
import assert from 'node:assert/strict';
import revenuecatRoute from '../api/revenuecat.js';

// RevenueCat's webhook, with made-up events and a fake database. Nothing
// reaches RevenueCat or Supabase.

const SAM = '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61';
const DANA = 'f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42';
const AUTH = 'made-up-webhook-value';
const NOW = 1794583518000;
const DAY = 24 * 60 * 60 * 1000;

const fakeSupabase = ({ fail } = {}) => {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (fail) return { data: null, error: { code: '57014', message: fail } };
    if (name === 'grant_ai_credits') return { data: { granted: true, creditBalance: 10 }, error: null };
    if (name === 'record_billing_event') return { data: true, error: null };
    if (name === 'set_plan_source') return { data: { tier: args.p_state.active ? 'premium' : 'free' }, error: null };
    return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
  };
  return { calls, admin: { rpc } };
};

const withFakes = (t, options) => {
  const supabase = fakeSupabase(options);
  t.mock.method(revenuecatRoute.deps, 'getSupabaseAdmin', () => supabase.admin);
  t.mock.method(revenuecatRoute.deps, 'now', () => NOW);
  t.mock.method(console, 'log', () => {});
  process.env.REVENUECAT_WEBHOOK_AUTH = AUTH;
  delete process.env.REVENUECAT_SECRET_KEY;
  t.after(() => { delete process.env.REVENUECAT_WEBHOOK_AUTH; });
  return supabase;
};

const send = async (event, { authorization = AUTH } = {}) => {
  const res = {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const headers = { 'content-type': 'application/json' };
  if (authorization) headers.authorization = authorization;
  await revenuecatRoute({ method: 'POST', headers, body: { api_version: '1.0', event } }, res);
  return res;
};

const proEvent = (type, extra = {}) => ({
  id: `evt_${type}`,
  type,
  app_user_id: SAM,
  entitlement_ids: ['Nightlink Pro'],
  product_id: 'nightlink_pro_monthly',
  environment: 'PRODUCTION',
  event_timestamp_ms: NOW - 1000,
  expiration_at_ms: NOW + 30 * DAY,
  ...extra,
});

const planCalls = (supabase) => supabase.calls.filter((c) => c.name === 'set_plan_source').map((c) => c.args);

test('only RevenueCat, with the value set in its dashboard, gets in', async (t) => {
  const supabase = withFakes(t);

  assert.equal((await send(proEvent('INITIAL_PURCHASE'), { authorization: null })).statusCode, 401);
  assert.equal((await send(proEvent('INITIAL_PURCHASE'), { authorization: 'wrong' })).statusCode, 401);
  assert.equal((await send(proEvent('INITIAL_PURCHASE'), { authorization: `${AUTH}x` })).statusCode, 401);
  assert.equal(supabase.calls.length, 0);

  assert.equal((await send(proEvent('INITIAL_PURCHASE'))).statusCode, 200);
  assert.equal((await send(proEvent('RENEWAL'), { authorization: `Bearer ${AUTH}` })).statusCode, 200);

  delete process.env.REVENUECAT_WEBHOOK_AUTH;
  t.mock.method(console, 'error', () => {});
  assert.equal((await send(proEvent('RENEWAL'))).statusCode, 503, 'not set up refuses everyone');
});

test("RevenueCat's test event is noted, which is what lets step 2 of the rollout run", async (t) => {
  const supabase = withFakes(t);
  assert.equal((await send({ id: 'evt_test_1', type: 'TEST', app_user_id: 'whoever' })).statusCode, 200);
  assert.deepEqual(supabase.calls.map((c) => [c.name, c.args.p_key, c.args.p_source, c.args.p_kind]), [
    ['record_billing_event', 'revenuecat:evt_test_1', 'revenuecat', 'TEST'],
  ]);
});

test('a purchase, a renewal and a cancellation keep Pro on until it runs out', async (t) => {
  const supabase = withFakes(t);
  await send(proEvent('INITIAL_PURCHASE'));
  await send(proEvent('RENEWAL', { expiration_at_ms: NOW + 60 * DAY }));
  await send(proEvent('CANCELLATION', { expiration_at_ms: NOW + 60 * DAY }));

  const plans = planCalls(supabase);
  assert.deepEqual(plans.map((p) => [p.p_user_id, p.p_source, p.p_state.active]), [
    [SAM, 'apple', true],
    [SAM, 'apple', true],
    [SAM, 'apple', true],
  ]);
  assert.equal(plans[1].p_state.expiresAt, new Date(NOW + 60 * DAY).toISOString());
  assert.equal(plans[0].p_state.eventAt, NOW - 1000, "RevenueCat's event time goes along, so an older event can't undo a newer one");
});

test('expiry and a refund turn Pro off, but only the App Store part of the plan', async (t) => {
  const supabase = withFakes(t);
  await send(proEvent('EXPIRATION', { expiration_at_ms: NOW - DAY }));
  await send(proEvent('CANCELLATION', { cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: NOW - 60 * 1000 }));
  const plans = planCalls(supabase);
  assert.deepEqual(plans.map((p) => [p.p_source, p.p_state.active]), [['apple', false], ['apple', false]]);
  assert.ok(plans.every((p) => p.p_source === 'apple'), 'never the web part');
});

test('a lifetime purchase is Pro with no end', async (t) => {
  const supabase = withFakes(t);
  await send(proEvent('NON_RENEWING_PURCHASE', { product_id: 'nightlink_pro_lifetime', expiration_at_ms: null }));
  const [plan] = planCalls(supabase);
  assert.equal(plan.p_state.active, true);
  assert.equal(plan.p_state.expiresAt, null);
});

test('a credit pack bought in the app is added once per App Store transaction', async (t) => {
  const supabase = withFakes(t);
  const pack = {
    id: 'evt_pack',
    type: 'NON_RENEWING_PURCHASE',
    app_user_id: SAM,
    entitlement_ids: null,
    product_id: 'nightlink_ai_credits_10',
    transaction_id: '2000000123456789',
    purchased_at_ms: NOW - 5000,
    event_timestamp_ms: NOW - 4000,
  };
  await send(pack);
  await send({ ...pack, id: 'evt_pack_retry' });
  const grants = supabase.calls.filter((c) => c.name === 'grant_ai_credits').map((c) => c.args);
  assert.equal(grants.length, 2);
  assert.ok(grants.every((g) => g.p_key === 'revenuecat:tx:2000000123456789'), 'one key for the transaction, so the database adds it once');
  assert.equal(grants[0].p_user_id, SAM);
  assert.equal(grants[0].p_amount, 10);
  assert.equal(grants[0].p_source, 'revenuecat');
  assert.equal(grants[0].p_purchased_at, new Date(NOW - 5000).toISOString());
  assert.equal(planCalls(supabase).length, 0, 'credits leave the plan alone');
});

test("an event with no Nightlink account on it changes nothing, and a moved purchase ends the old account's Pro", async (t) => {
  const supabase = withFakes(t);
  await send(proEvent('INITIAL_PURCHASE', { app_user_id: '$RCAnonymousID:abc', original_app_user_id: '$RCAnonymousID:abc', aliases: [] }));
  assert.equal(planCalls(supabase).length, 0);

  await send({ id: 'evt_transfer', type: 'TRANSFER', transferred_from: [SAM], transferred_to: [DANA], event_timestamp_ms: NOW });
  assert.deepEqual(planCalls(supabase).map((p) => [p.p_user_id, p.p_state.active]), [[SAM, false]]);
});

test('a database error makes RevenueCat send the event again later', async (t) => {
  withFakes(t, { fail: 'canceling statement due to statement timeout' });
  t.mock.method(console, 'error', () => {});
  assert.equal((await send(proEvent('RENEWAL'))).statusCode, 500);
});
