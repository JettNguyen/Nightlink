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

// Every handler reaches Stripe and Supabase through these, so the tests can
// hand them fakes.
const deps = { getStripe, getSupabaseAdmin, rawBodyWaitMs: 5000 };

const setCors = (res, origin) => {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,stripe-signature');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
};

// ── Helpers for updating a user's Supabase profile ──────────────────────────

const addCredits = async (uid, amount) => {
  const admin = deps.getSupabaseAdmin();
  const { data: row } = await admin.from('profiles').select('ai_usage').eq('id', uid).single();
  const usage = row?.ai_usage || {};
  const current = typeof usage.creditBalance === 'number' ? usage.creditBalance : 0;
  await admin.from('profiles').update({
    ai_usage: { ...usage, creditBalance: current + amount }
  }).eq('id', uid);
};

const setPremiumTier = async (uid, tier = 'premium') => {
  const admin = deps.getSupabaseAdmin();
  const { data: row } = await admin.from('profiles').select('subscription').eq('id', uid).single();
  const sub = row?.subscription || {};
  await admin.from('profiles').update({
    subscription: { ...sub, tier }
  }).eq('id', uid);
};

// ── Shared by the handlers below ─────────────────────────────────────────────

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
const CHECKOUT_NOT_READY = "Buying on the website isn't working right now. Try again later, or write to "
  + "support@nightlink.dev and we'll sort it out.";
const CHECKOUT_FAILED = "Checkout didn't open. Try again in a minute, and if it still doesn't, write to "
  + 'support@nightlink.dev.';
const UNKNOWN_PRODUCT = "That isn't something we sell. Reload the page and try again.";

const getCaller = async (req) => {
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const { data, error } = await deps.getSupabaseAdmin().auth.getUser(token);
  const user = data?.user;
  return !error && user?.id ? user : null;
};

// ── Checkout session creation ─────────────────────────────────────────────────
// POST /api/stripe  { action: 'create_checkout', plan: 'pro' | 'credits' }
//
// Every purchase on the website goes through here, because this is what ties
// it to the Nightlink account: the uid from the caller's sign-in goes on the
// checkout and, for Pro, on the subscription, where the webhook and Manage plan
// find it. Stripe's payment links can't do that, which is why buying through
// them never turned Pro on.
//
// The price comes from the server's settings, never from the request, so a
// request can't buy something else or name its own price. Pages from before
// 11/13/2026 send { priceId, mode } instead of plan; their price still has to
// be one of these two, and the mode comes from the price.

const PRODUCTS = {
  pro: { mode: 'subscription', priceSettings: ['STRIPE_PREMIUM_PRICE_ID', 'VITE_STRIPE_PREMIUM_PRICE_ID'] },
  credits: { mode: 'payment', priceSettings: ['STRIPE_CREDIT_PRICE_ID', 'VITE_STRIPE_CREDIT_PRICE_ID'] },
};

const priceFor = (product) => product.priceSettings
  .map((name) => String(process.env[name] || '').trim())
  .find(Boolean) || '';

const productFor = (body) => {
  if (typeof body?.plan === 'string' && Object.hasOwn(PRODUCTS, body.plan)) return body.plan;
  if (typeof body?.priceId === 'string' && body.priceId) {
    return Object.keys(PRODUCTS).find((key) => priceFor(PRODUCTS[key]) === body.priceId) || null;
  }
  return null;
};

const handleCreateCheckout = async (req, res, body) => {
  let caller = null;
  try {
    caller = await getCaller(req);
  } catch (err) {
    console.error('Caller check failed:', err.message);
  }
  // A uid in the body that isn't the caller's means the page is out of date.
  if (!caller || (body?.uid && body.uid !== caller.id)) return res.status(401).json({ error: SIGN_IN_AGAIN });

  const key = productFor(body);
  if (!key) return res.status(400).json({ error: UNKNOWN_PRODUCT });
  const { mode } = PRODUCTS[key];
  const price = priceFor(PRODUCTS[key]);
  if (!price) {
    console.error(`Checkout refused: no price set for ${key} (STRIPE_${key === 'pro' ? 'PREMIUM' : 'CREDIT'}_PRICE_ID).`);
    return res.status(503).json({ error: CHECKOUT_NOT_READY });
  }

  let stripe;
  try {
    stripe = deps.getStripe();
  } catch (err) {
    console.error('Stripe is not set up:', err.message);
    return res.status(503).json({ error: CHECKOUT_NOT_READY });
  }

  const uid = caller.id;
  const origin = String(req.headers?.origin || '');
  const site = OWN_ORIGIN.test(origin) ? origin : SITE_ORIGIN;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode,
      line_items: [{ price, quantity: 1 }],
      client_reference_id: uid,
      // `client_reference_id` only lives on the checkout session. Later
      // subscription events (notably customer.subscription.deleted) carry the
      // subscription object instead, so the uid goes on that too. Without it a
      // cancellation has no account to change, and Manage plan can't find it.
      metadata: { uid, product: key },
      ...(mode === 'subscription' ? { subscription_data: { metadata: { uid } } } : {}),
      success_url: `${site}/settings?payment=success`,
      cancel_url: `${site}/settings?payment=cancelled`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout failed:', err.message);
    return res.status(502).json({ error: CHECKOUT_FAILED });
  }
};

// ── Stripe webhook ────────────────────────────────────────────────────────────
// POST /api/stripe  (raw body, stripe-signature header)
//
// Stripe signs the exact bytes it sends, so the check has to see those bytes.
// Rebuilding them from req.body never matches: Stripe sends indented JSON and
// JSON.stringify doesn't indent, so every event used to fail the check. This
// path never touches req.body. On Vercel the platform reads the body before
// the handler runs and plays the same bytes back to anything listening on the
// request; the local dev server keeps them on req.rawBody instead.

const readRawBody = (req) => {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);
  if (typeof req.rawBody === 'string') return Promise.resolve(Buffer.from(req.rawBody, 'utf8'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    // A body someone else already read never ends. Give up instead of holding
    // the function open until Vercel stops it.
    const timer = setTimeout(() => reject(new Error('the request body never arrived')), deps.rawBodyWaitMs);
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
};

const handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature' });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Webhook refused: STRIPE_WEBHOOK_SECRET is not set.');
    return res.status(500).json({ error: 'Webhook is not set up' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('Webhook body could not be read:', err.message);
    return res.status(400).json({ error: 'Could not read the request body' });
  }

  // The signature check needs only the signing secret, not the API key.
  let event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, sig, secret);
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

  // Stripe's webhook is told apart by its signature header alone, before
  // anything reads req.body: the signature check needs the raw bytes. Stripe's
  // endpoint stays /api/stripe.
  const contentType = req.headers['content-type'] || '';
  const isWebhook = req.headers['stripe-signature'];

  if (isWebhook) return handleWebhook(req, res);

  let body = req.body;
  if (typeof body === 'string' && contentType.includes('application/json')) {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  if (body?.action === 'create_checkout') return handleCreateCheckout(req, res, body);
  if (body?.action === 'plan_status' || body?.action === 'manage_plan') {
    return handleManagePlan(req, res, body.action);
  }

  return res.status(400).json({ error: 'Unknown action' });
};

module.exports.deps = deps;
