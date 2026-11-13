// Stripe integration for web payments on AI credit packs and Premium subscriptions.
//
// Required env vars (Vercel dashboard):
//   STRIPE_SECRET_KEY:         your Stripe secret key (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET:     from `stripe listen` or the Stripe dashboard
//   SUPABASE_URL:              your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY: service role key (never expose on the client)
//
// RevenueCat (iOS) posts to /api/revenuecat, so add that endpoint when you build
// the iOS app. Both payment paths converge on the same Supabase profile updates below.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const AI_CREDIT_PACK_SIZE = 10; // credits awarded per $0.99 purchase

const getStripe = () => Stripe(process.env.STRIPE_SECRET_KEY);

const getSupabaseAdmin = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const setCors = (res, origin) => {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,stripe-signature');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
};

// ── Helpers for updating a user's Supabase profile ──────────────────────────

const addCredits = async (uid, amount) => {
  const admin = getSupabaseAdmin();
  const { data: row } = await admin.from('profiles').select('ai_usage').eq('id', uid).single();
  const usage = row?.ai_usage || {};
  const current = typeof usage.creditBalance === 'number' ? usage.creditBalance : 0;
  await admin.from('profiles').update({
    ai_usage: { ...usage, creditBalance: current + amount }
  }).eq('id', uid);
};

const setPremiumTier = async (uid, tier = 'premium') => {
  const admin = getSupabaseAdmin();
  const { data: row } = await admin.from('profiles').select('subscription').eq('id', uid).single();
  const sub = row?.subscription || {};
  await admin.from('profiles').update({
    subscription: { ...sub, tier }
  }).eq('id', uid);
};

// ── Checkout session creation ─────────────────────────────────────────────────
// POST /api/stripe  { action: 'create_checkout', uid, priceId, mode }

const handleCreateCheckout = async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const { uid, priceId, successUrl, cancelUrl, mode = 'payment' } = body || {};
  if (!uid || !priceId) return res.status(400).json({ error: 'Missing uid or priceId' });

  // Verify the caller is authenticated and matches the uid
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const admin = getSupabaseAdmin();
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user || user.id !== uid) return res.status(401).json({ error: 'Invalid session' });

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: uid,
    // `client_reference_id` only lives on the checkout session. Later
    // subscription events (notably customer.subscription.deleted) carry the
    // subscription object instead, so stamp the uid onto it here, because without this
    // a cancellation has no user to downgrade and silently does nothing.
    metadata: { uid },
    ...(mode === 'subscription' ? { subscription_data: { metadata: { uid } } } : {}),
    success_url: successUrl || `${req.headers.origin}/settings?payment=success`,
    cancel_url:  cancelUrl  || `${req.headers.origin}/settings?payment=cancelled`,
  });

  res.status(200).json({ url: session.url });
};

// ── Stripe webhook ────────────────────────────────────────────────────────────
// POST /api/stripe  (raw body, stripe-signature header)

const handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature' });

  let event;
  try {
    const stripe = getStripe();
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const uid = event.data.object?.client_reference_id
    || event.data.object?.metadata?.uid;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (!uid) break;
        if (session.mode === 'payment') {
          // One-time credit pack purchase
          await addCredits(uid, AI_CREDIT_PACK_SIZE);
          console.log(`Added ${AI_CREDIT_PACK_SIZE} credits to ${uid}`);
        } else if (session.mode === 'subscription') {
          await setPremiumTier(uid, 'premium');
          console.log(`Set premium for ${uid}`);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        // Subscription cancelled, so downgrade to free
        if (uid) {
          await setPremiumTier(uid, 'free');
          console.log(`Downgraded ${uid} to free`);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: 'Handler failed' });
  }

  res.status(200).json({ received: true });
};

// ── Managing a plan bought on the website ─────────────────────────────────────
// POST /api/stripe  { action: 'plan_status' }  answers { webPlan: true | false }
// POST /api/stripe  { action: 'manage_plan' }  answers { url } of Stripe's billing
//                                              page, to cancel, change the card or
//                                              see past payments
//
// Both answer for the caller only. Who that is comes from the Supabase access
// token in the Authorization header, checked by Supabase. Nothing in the body is
// read, so a uid or customer id sent there changes nothing. The customer comes
// from Stripe: the subscription that create_checkout stamped with the caller's
// uid. The profile row is no help here, because its owner can write anything
// into it. A plan bought through a Stripe payment link carries no uid, so it
// isn't found until `uid` is added to that subscription's metadata in Stripe.

// The billing handlers reach Stripe and Supabase through these, so the tests
// can hand them fakes.
const deps = { getStripe, getSupabaseAdmin };

const SITE_ORIGIN = 'https://www.nightlink.dev';
const OWN_ORIGIN = /^(https:\/\/(www\.)?nightlink\.dev|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Statuses where a plan is still going and can be canceled or paid.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

// Shown on screen as they are, so they're plain and say what to do.
const SIGN_IN_AGAIN = 'Sign in again, then try once more.';
const NO_WEB_PLAN = "We couldn't find a plan bought on nightlink.dev for this account. "
  + 'If you got Pro in the iPhone app, change or cancel it on your iPhone: open the Settings app, '
  + 'tap your name, then Subscriptions. If you paid on nightlink.dev, write to support@nightlink.dev '
  + "from the email you paid with and we'll cancel it for you.";
const NOT_READY = "Managing your plan here isn't ready yet. Write to support@nightlink.dev from the "
  + "email you paid with and we'll cancel or change it for you.";
const TRY_AGAIN = "Your plan didn't open. Try again in a minute, and if it still doesn't, write to "
  + 'support@nightlink.dev.';

const getCaller = async (req) => {
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const { data, error } = await deps.getSupabaseAdmin().auth.getUser(token);
  const user = data?.user;
  return !error && user?.id ? user : null;
};

// A plan that will renew comes first, then one already set to end, then any
// other, newest first among equals.
const planRank = (sub) => {
  if (!LIVE_STATUSES.has(sub.status)) return 0;
  return sub.cancel_at_period_end || sub.cancel_at ? 1 : 2;
};

// The caller's web plan, or null. Only subscriptions stamped with this uid
// count, and each result is checked again in case the search ever returns more.
const findWebPlan = async (stripe, uid) => {
  if (!UUID.test(uid)) return null;
  const { data } = await stripe.subscriptions.search({ query: `metadata['uid']:'${uid}'`, limit: 100 });
  const best = (data || [])
    .filter((sub) => sub?.metadata?.uid === uid && sub.customer)
    .sort((a, b) => planRank(b) - planRank(a) || (b.created || 0) - (a.created || 0))[0];
  if (!best) return null;
  const customer = typeof best.customer === 'string' ? best.customer : best.customer.id;
  return customer ? { customer, live: LIVE_STATUSES.has(best.status) } : null;
};

// Stripe refuses to open the billing page until it has been set up once in the
// Dashboard, separately for test mode and live mode.
const isBillingPageOff = (err) => (
  err?.type === 'StripeInvalidRequestError'
  && /configuration|settings\/billing\/portal/i.test(err?.message || '')
);

const handleManagePlan = async (req, res, action) => {
  let caller = null;
  try {
    caller = await getCaller(req);
  } catch (err) {
    console.error('Caller check failed:', err.message);
  }
  if (!caller) return res.status(401).json({ error: SIGN_IN_AGAIN });

  let stripe;
  try {
    stripe = deps.getStripe();
  } catch (err) {
    console.error('Stripe is not set up:', err.message);
    return res.status(503).json({ error: NOT_READY });
  }

  let plan;
  try {
    plan = await findWebPlan(stripe, caller.id);
  } catch (err) {
    console.error('Web plan lookup failed:', err.message);
    return res.status(502).json({ error: TRY_AGAIN });
  }

  if (action === 'plan_status') return res.status(200).json({ webPlan: Boolean(plan?.live) });
  if (!plan) return res.status(404).json({ error: NO_WEB_PLAN, code: 'no_web_plan' });

  const origin = String(req.headers?.origin || '');
  try {
    const page = await stripe.billingPortal.sessions.create({
      customer: plan.customer,
      return_url: `${OWN_ORIGIN.test(origin) ? origin : SITE_ORIGIN}/settings`,
    });
    return res.status(200).json({ url: page.url });
  } catch (err) {
    if (isBillingPageOff(err)) {
      // The message names the Dashboard page where it gets turned on.
      console.error('Stripe billing page is not turned on:', err.message);
      return res.status(503).json({ error: NOT_READY, code: 'billing_page_off' });
    }
    console.error('Stripe billing page failed:', err.message);
    return res.status(502).json({ error: TRY_AGAIN });
  }
};

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  setCors(res, req.headers?.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Distinguish checkout creation (JSON body with action field) from Stripe webhooks
  const contentType = req.headers['content-type'] || '';
  const isWebhook = req.headers['stripe-signature'];

  if (isWebhook) return handleWebhook(req, res);

  let body = req.body;
  if (typeof body === 'string' && contentType.includes('application/json')) {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  if (body?.action === 'create_checkout') return handleCreateCheckout(req, res);
  if (body?.action === 'plan_status' || body?.action === 'manage_plan') {
    return handleManagePlan(req, res, body.action);
  }

  return res.status(400).json({ error: 'Unknown action' });
};

module.exports.deps = deps;
