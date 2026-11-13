// RevenueCat's webhook: how App Store purchases reach the server.
//
// POST /api/revenuecat, sent by RevenueCat with the Authorization header set in
// its dashboard (Project settings, Integrations, Webhooks). That value goes in
// REVENUECAT_WEBHOOK_AUTH here; a request without it is refused.
//
// Apps can't change their own plan or credits once step 2 of the profile
// privacy rollout is in, so this is what turns on Pro bought in the iPhone app,
// keeps it on through renewals, ends it when it expires, and adds credit packs.
// It changes only the apple part of the plan, so a plan bought on the website
// stays whatever happens here. Sandbox purchases count too: App Review buys in
// the sandbox, and 1.3.2 always honored them.
//
// RevenueCat retries a delivery that doesn't get a 200, so an error here
// answers 500 and the same event comes back later. Every change is safe to
// repeat: plans keep the time of the event they came from and ignore older
// ones, and credits are added once per App Store transaction.

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const billing = require('./_lib/billing');

const getSupabaseAdmin = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const deps = { getSupabaseAdmin, now: () => Date.now() };

// Events that say where Pro stands: on until expiration_at_ms. A cancellation
// only turns off renewing, so it stays on until then too; a refund comes as a
// cancellation whose expiration has already passed.
const PLAN_EVENTS = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'CANCELLATION', 'BILLING_ISSUE',
  'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT', 'REFUND_REVERSED', 'SUBSCRIPTION_PAUSED',
  'NON_RENEWING_PURCHASE', 'EXPIRATION',
]);

const authorized = (header) => {
  const expected = String(process.env.REVENUECAT_WEBHOOK_AUTH || '');
  const given = Buffer.from(String(header || ''));
  return [expected, `Bearer ${expected}`].some((candidate) => {
    const wanted = Buffer.from(candidate);
    return wanted.length === given.length && crypto.timingSafeEqual(wanted, given);
  });
};

const hasPro = (event) => (
  (Array.isArray(event.entitlement_ids) && event.entitlement_ids.includes(billing.ENTITLEMENT_PRO))
  || event.entitlement_id === billing.ENTITLEMENT_PRO
);

// The app logs in to RevenueCat with the Supabase user id, so that's who it is.
const accountFor = (event) => [event.app_user_id, event.original_app_user_id, ...(event.aliases || [])]
  .find((id) => typeof id === 'string' && billing.UUID.test(id)) || null;

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// What one event changes. Returns a word for the log.
const applyRevenueCatEvent = async (admin, event) => {
  const eventAt = Number(event.event_timestamp_ms) || deps.now();
  const note = (uid, extra = {}) => billing.recordEvent(admin, {
    key: `revenuecat:${event.id}`,
    source: 'revenuecat',
    kind: event.type,
    uid,
    detail: { environment: event.environment || null, productId: event.product_id || null, ...extra },
  });

  if (event.type === 'TEST') {
    await note(null);
    return 'test event noted';
  }

  if (event.type === 'TRANSFER') {
    // The purchases moved to another account. Pro ends on the old ones; the new
    // one gets it from its next event, or right away when the server can ask
    // RevenueCat (REVENUECAT_SECRET_KEY).
    const from = (event.transferred_from || []).filter((id) => billing.UUID.test(id));
    const to = (event.transferred_to || []).filter((id) => billing.UUID.test(id));
    for (const uid of from) {
      await billing.setPlanSource(admin, uid, 'apple', { active: false, from: 'revenuecat', reason: 'transferred', eventAt });
    }
    for (const uid of to) await billing.refreshApplePlan(admin, uid, { now: deps.now() });
    await note(to[0] || null, { transferredFrom: from, transferredTo: to });
    return 'transfer applied';
  }

  const uid = accountFor(event);
  if (!uid) {
    await note(null, { appUserId: event.app_user_id || null });
    return 'no account on it';
  }

  // A credit pack: a one-time purchase that isn't Pro.
  if (event.type === 'NON_RENEWING_PURCHASE' && !hasPro(event)) {
    const result = await billing.grantCredits(admin, {
      uid,
      key: `revenuecat:tx:${event.transaction_id || event.id}`,
      source: 'revenuecat',
      purchasedAt: iso(Number(event.purchased_at_ms)) || iso(eventAt),
    });
    return result?.granted ? `added ${billing.CREDIT_PACK_SIZE} credits` : `no credits added (${result?.reason})`;
  }

  if (PLAN_EVENTS.has(event.type) && hasPro(event)) {
    // No expiration means for good, like a lifetime purchase.
    const expires = event.expiration_at_ms == null ? null : Number(event.expiration_at_ms);
    const active = event.type !== 'EXPIRATION' && (expires === null || expires > deps.now());
    await billing.setPlanSource(admin, uid, 'apple', {
      active,
      expiresAt: iso(expires),
      productId: event.product_id || null,
      environment: event.environment || null,
      from: 'revenuecat',
      eventAt,
    });
    await note(uid);
    return `Pro ${active ? 'on' : 'off'}`;
  }

  await note(uid);
  return 'nothing to change';
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.REVENUECAT_WEBHOOK_AUTH) {
    console.error('RevenueCat webhook refused: REVENUECAT_WEBHOOK_AUTH is not set.');
    return res.status(503).json({ error: 'Webhook is not set up' });
  }
  if (!authorized(req.headers?.authorization)) return res.status(401).json({ error: 'Unauthorized' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const event = body?.event;
  if (!event?.type || !event?.id) return res.status(400).json({ error: 'Not a RevenueCat event' });

  try {
    const outcome = await applyRevenueCatEvent(deps.getSupabaseAdmin(), event);
    console.log(`RevenueCat ${event.type} ${event.id}: ${outcome}`);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('RevenueCat event failed:', event.type, event.id, err.message);
    return res.status(500).json({ error: 'Handler failed' });
  }
};

module.exports.deps = deps;
