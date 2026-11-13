#!/usr/bin/env node
// Puts the Nightlink account on purchases made through Stripe's old payment
// links. Those links never recorded who was buying, so the webhook couldn't
// turn Pro on and Manage plan can't find the plan. Jett runs this himself.
//
//   node scripts/stripe-link-buyers.mjs
//       Lists every subscription with no account on it, and every credit pack
//       paid through a payment link, and writes link-buyers.json for you to
//       fill in. Changes nothing.
//
//   node scripts/stripe-link-buyers.mjs --apply link-buyers.json
//       Shows what it would write. Changes nothing.
//
//   node scripts/stripe-link-buyers.mjs --apply link-buyers.json --yes
//       Writes each uid you filled in onto its subscription in Stripe (the
//       subscription's metadata). Stripe then sends customer.subscription.updated
//       and the webhook turns Pro on for that account. A subscription that
//       already names an account is never changed.
//
// The key comes from STRIPE_SECRET_KEY, or from .env.local or .env. It's never
// printed; only whether it's a test or a live key.
//
// Matching a buyer to an account: Supabase doesn't confirm email addresses on
// this project, so an account with the buyer's email isn't proof it's theirs.
// Ask the buyer which account they use (a reply to their receipt works), or at
// least check the account was made before the purchase. The uid is the id on
// Supabase, Authentication, Users.
//
// The file holds buyers' emails. Delete it when you're done.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENDED = new Set(['canceled', 'incomplete_expired']);

const day = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : '');

/** Everything bought through a payment link that has no account on it. */
export async function findLinkPurchases(stripe) {
  const subscriptions = [];
  for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.customer'] })) {
    if (sub.metadata?.uid) continue;
    const customer = typeof sub.customer === 'string' ? { id: sub.customer } : (sub.customer || {});
    subscriptions.push({
      subscription: sub.id,
      status: sub.status,
      ended: ENDED.has(sub.status),
      customer: customer.id || '',
      email: customer.email || '',
      started: day(sub.created),
      uid: '',
    });
  }

  const creditPacks = [];
  for await (const session of stripe.checkout.sessions.list({ status: 'complete', limit: 100 })) {
    if (session.mode !== 'payment' || !session.payment_link) continue;
    if (session.client_reference_id || session.metadata?.uid) continue;
    creditPacks.push({
      checkout: session.id,
      email: session.customer_details?.email || '',
      paid: day(session.created),
      uid: '',
    });
  }

  return { subscriptions, creditPacks };
}

/** What --apply would write, and why it skips the rest. */
export async function planWrites(stripe, entries) {
  const writes = [];
  const skipped = [];
  for (const entry of entries || []) {
    const uid = String(entry?.uid || '').trim();
    if (!uid) continue;
    if (!UUID.test(uid)) {
      skipped.push({ subscription: entry.subscription, why: `"${uid}" isn't a uid` });
      continue;
    }
    const sub = await stripe.subscriptions.retrieve(entry.subscription);
    const current = sub.metadata?.uid;
    if (current === uid) {
      skipped.push({ subscription: sub.id, why: 'already has this uid' });
    } else if (ENDED.has(sub.status)) {
      // Nothing to turn on, and putting an account on it would only end Pro
      // given by hand from before.
      skipped.push({ subscription: sub.id, why: `it has ended (${sub.status}), so there's no Pro to turn on` });
    } else if (current) {
      skipped.push({ subscription: sub.id, why: `already names another account (${current}), left as it is` });
    } else {
      writes.push({ subscription: sub.id, uid });
    }
  }
  return { writes, skipped };
}

/** Writes each uid onto its subscription. Stripe merges metadata, so nothing else on it changes. */
export async function applyWrites(stripe, writes) {
  const done = [];
  for (const { subscription, uid } of writes) {
    await stripe.subscriptions.update(subscription, { metadata: { uid } });
    done.push(subscription);
  }
  return done;
}

const keyMode = (key) => {
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  return 'unknown';
};

async function main(argv) {
  const { config } = await import('dotenv');
  config({ path: '.env.local', quiet: true });
  config({ quiet: true });

  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) {
    console.error('Set STRIPE_SECRET_KEY first, for example: STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-link-buyers.mjs');
    return 1;
  }
  const { default: Stripe } = await import('stripe');
  const stripe = Stripe(key);
  console.log(`Using a ${keyMode(key)} mode key.`);

  const applyAt = argv.indexOf('--apply');
  if (applyAt === -1) {
    const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'link-buyers.json';
    const found = await findLinkPurchases(stripe);
    console.log(`\nSubscriptions with no account on them: ${found.subscriptions.length}`);
    for (const s of found.subscriptions) {
      console.log(`  ${s.subscription}  ${s.status}${s.ended ? ' (ended)' : ''}  since ${s.started}  ${s.email || '(no email)'}`);
    }
    console.log(`\nCredit packs paid through a payment link: ${found.creditPacks.length}`);
    for (const c of found.creditPacks) {
      console.log(`  ${c.checkout}  paid ${c.paid}  ${c.email || '(no email)'}`);
    }
    if (found.creditPacks.length) {
      console.log('\nThose credits were never added. Once the account is known, add them in Supabase\'s SQL editor');
      console.log('(after step 1 of the profile privacy rollout), once per pack:');
      console.log("  select public.grant_ai_credits('<uid>', 10, 'stripe:<checkout id>', 'stripe', now());");
    }
    writeFileSync(out, `${JSON.stringify(found, null, 2)}\n`);
    console.log(`\nWrote ${out}. Fill in "uid" for each subscription you've matched to an account, then run`);
    console.log(`  node scripts/stripe-link-buyers.mjs --apply ${out}`);
    console.log('It holds buyers\' emails, so delete it when you\'re done.');
    return 0;
  }

  const file = argv[applyAt + 1];
  if (!file) {
    console.error('Name the file: --apply link-buyers.json');
    return 1;
  }
  const entries = JSON.parse(readFileSync(file, 'utf8')).subscriptions || [];
  const { writes, skipped } = await planWrites(stripe, entries);
  for (const s of skipped) console.log(`Skipping ${s.subscription}: ${s.why}`);
  for (const w of writes) console.log(`Will put uid ${w.uid} on ${w.subscription}`);
  if (!writes.length) {
    console.log('Nothing to write. Fill in "uid" in the file first.');
    return 0;
  }
  if (!argv.includes('--yes')) {
    console.log('\nNothing changed. Add --yes to write these.');
    return 0;
  }
  const done = await applyWrites(stripe, writes);
  console.log(`\nWrote ${done.length}. Stripe sends customer.subscription.updated for each, and the webhook turns Pro on.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(err.message); process.exitCode = 1; },
  );
}
