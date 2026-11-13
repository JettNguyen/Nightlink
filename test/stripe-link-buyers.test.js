import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLinkPurchases, planWrites, applyWrites, stripeFor } from '../scripts/stripe-link-buyers.mjs';

// The script Jett runs for people who bought through the old payment links,
// against a fake Stripe.

const SAM = '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61';
const DANA = 'f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42';

const pages = (items) => ({
  async* [Symbol.asyncIterator]() { yield* items; },
});

const fakeStripe = () => {
  const subscriptions = {
    sub_link_sam: { id: 'sub_link_sam', status: 'active', created: 1793000000, metadata: {}, customer: { id: 'cus_a', email: 'sam@example.com' } },
    sub_link_ended: { id: 'sub_link_ended', status: 'canceled', created: 1790000000, metadata: {}, customer: 'cus_b' },
    sub_checkout_dana: { id: 'sub_checkout_dana', status: 'active', created: 1793500000, metadata: { uid: DANA }, customer: 'cus_c' },
  };
  const sessions = [
    { id: 'cs_link_pack', mode: 'payment', payment_link: 'plink_credits', created: 1793100000, metadata: {}, customer_details: { email: 'ellen@example.com' } },
    { id: 'cs_checkout_pack', mode: 'payment', payment_link: null, client_reference_id: DANA, created: 1793200000, metadata: { uid: DANA } },
    { id: 'cs_link_sub', mode: 'subscription', payment_link: 'plink_pro', created: 1793000000, metadata: {} },
  ];
  const updates = [];
  return {
    updates,
    subscriptions: {
      list: () => pages(Object.values(subscriptions)),
      retrieve: async (id) => subscriptions[id],
      update: async (id, params) => {
        updates.push({ id, params });
        subscriptions[id] = { ...subscriptions[id], metadata: { ...subscriptions[id].metadata, ...params.metadata } };
        return subscriptions[id];
      },
    },
    checkout: { sessions: { list: () => pages(sessions) } },
  };
};

test('the list shows what has no account on it and changes nothing', async () => {
  const stripe = fakeStripe();
  const found = await findLinkPurchases(stripe);

  assert.deepEqual(found.subscriptions.map((s) => [s.subscription, s.ended, s.email, s.uid]), [
    ['sub_link_sam', false, 'sam@example.com', ''],
    ['sub_link_ended', true, '', ''],
  ]);
  assert.deepEqual(found.creditPacks.map((c) => [c.checkout, c.email]), [['cs_link_pack', 'ellen@example.com']]);
  assert.equal(stripe.updates.length, 0);
});

test('applying writes only filled-in uids, and never replaces an account already there', async () => {
  const stripe = fakeStripe();
  const entries = [
    { subscription: 'sub_link_sam', uid: SAM },
    { subscription: 'sub_link_ended', uid: '' },
    { subscription: 'sub_checkout_dana', uid: SAM },
    { subscription: 'sub_link_ended', uid: 'sam@example.com' },
    { subscription: 'sub_link_ended', uid: DANA },
  ];

  const { writes, skipped } = await planWrites(stripe, entries);
  assert.deepEqual(writes, [{ subscription: 'sub_link_sam', uid: SAM }]);
  assert.deepEqual(skipped.map((s) => s.subscription), ['sub_checkout_dana', 'sub_link_ended', 'sub_link_ended']);
  assert.match(skipped[0].why, /another account/);
  assert.match(skipped[2].why, /has ended/, 'an ended plan gets no account: there is no Pro to turn on');
  assert.equal(stripe.updates.length, 0, 'planning writes nothing');

  await applyWrites(stripe, writes);
  assert.deepEqual(stripe.updates, [{ id: 'sub_link_sam', params: { metadata: { uid: SAM } } }]);

  // Run again, it's a no-op.
  const again = await planWrites(stripe, entries);
  assert.equal(again.writes.length, 0);
  assert.match(again.skipped[0].why, /already has this uid/);
});

// The other tests use a fake Stripe, so they never started a real one, and the
// script stopped on Jett's first live run with "Class constructor Stripe cannot
// be invoked without 'new'". Starting the client makes no request.
test('the script starts a real Stripe client', async () => {
  const stripe = await stripeFor('sk_test_not_a_real_key');
  assert.equal(typeof stripe.subscriptions.list, 'function');
  assert.equal(typeof stripe.subscriptions.update, 'function');
  assert.equal(typeof stripe.checkout.sessions.list, 'function');
});
