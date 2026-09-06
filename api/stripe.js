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

  return res.status(400).json({ error: 'Unknown action' });
};
