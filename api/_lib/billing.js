// Plans and AI credits, changed only by the server, with the service key.
//
// Lives under api/_lib so Vercel doesn't make it an endpoint of its own.
//
// A plan has a part per source (see supabase/rollout/1-profile-privacy-add.sql):
//   apple   the App Store, as RevenueCat reports it
//   web     a subscription bought on nightlink.dev, as Stripe reports it
//   comp    the PREMIUM_EMAILS list
//   legacy  Pro from before plans had sources, with nothing on record
// The database works out tier from them, so one source turning off never ends
// Pro that another source still pays for. Apps can't write any of it.

const ENTITLEMENT_PRO = 'Nightlink Pro';
const CREDIT_PACK_SIZE = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PostgREST's answer when a function doesn't exist yet, as before step 1 of
// the rollout.
const isMissingFunction = (error) => (
  error?.code === 'PGRST202' || error?.code === '42883' || /could not find the function/i.test(error?.message || '')
);

const call = async (admin, name, args) => {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw Object.assign(new Error(`${name} failed: ${error.message}`), { code: error.code, cause: error });
  return data;
};

/** Sets one source of a plan. Returns the plan, or null when there's no such profile. */
const setPlanSource = (admin, uid, source, state) => call(admin, 'set_plan_source', {
  p_user_id: uid,
  p_source: source,
  p_state: state,
});

/** Adds a credit pack once per purchase key. Returns { granted, reason?, creditBalance? }. */
const grantCredits = (admin, { uid, amount = CREDIT_PACK_SIZE, key, source, purchasedAt }) => call(admin, 'grant_ai_credits', {
  p_user_id: uid,
  p_amount: amount,
  p_key: key,
  p_source: source,
  p_purchased_at: purchasedAt || new Date().toISOString(),
});

/**
 * Whether someone is on PREMIUM_EMAILS, the comp list. Matched against the
 * email they sign in with, from their verified session, not profiles.email:
 * apps can write that column, so anyone could put a listed email there.
 */
const isComped = (user, list = process.env.PREMIUM_EMAILS) => {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return false;
  return String(list || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
};

/** Notes a payment event. True the first time its key is seen. */
const recordEvent = (admin, { key, source, kind, uid = null, detail = {} }) => call(admin, 'record_billing_event', {
  p_key: key,
  p_source: source,
  p_kind: kind,
  p_user_id: uid,
  p_detail: detail,
});

// ── RevenueCat ───────────────────────────────────────────────────────────────

/**
 * What RevenueCat says about Pro right now, asked directly. Needs
 * REVENUECAT_SECRET_KEY (RevenueCat, Project settings, API keys, a secret key);
 * without it this returns null and the webhook alone keeps plans current.
 */
const fetchApplePro = async (uid, { fetchImpl = fetch, now = Date.now() } = {}) => {
  const key = String(process.env.REVENUECAT_SECRET_KEY || '').trim();
  if (!key || !UUID.test(uid)) return null;
  const response = await fetchImpl(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(uid)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`RevenueCat answered ${response.status}`);
  const payload = await response.json();
  const entitlement = payload?.subscriber?.entitlements?.[ENTITLEMENT_PRO];
  if (!entitlement) return { active: false, expiresAt: null };
  const ends = [entitlement.expires_date, entitlement.grace_period_expires_date]
    .filter(Boolean)
    .map((date) => Date.parse(date))
    .filter(Number.isFinite);
  const active = entitlement.expires_date === null || ends.some((end) => end > now);
  return {
    active,
    expiresAt: entitlement.expires_date || null,
    productId: entitlement.product_identifier || null,
  };
};

/** Asks RevenueCat and records the answer as the plan's apple part. Null when it can't ask. */
const refreshApplePlan = async (admin, uid, options = {}) => {
  const now = options.now ?? Date.now();
  const pro = await fetchApplePro(uid, { ...options, now });
  if (!pro) return null;
  return setPlanSource(admin, uid, 'apple', { ...pro, from: 'revenuecat', eventAt: now });
};

module.exports = {
  ENTITLEMENT_PRO,
  CREDIT_PACK_SIZE,
  UUID,
  isMissingFunction,
  isComped,
  setPlanSource,
  grantCredits,
  recordEvent,
  fetchApplePro,
  refreshApplePlan,
};
