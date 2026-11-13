import { Capacitor } from '@capacitor/core';

/**
 * The account route (api/account.js): plan checks, reports, deleting an
 * account.
 *
 * Only the server changes plans and AI credits. It hears about purchases from
 * Stripe and RevenueCat, and checks the comp list. The app asks it what the
 * plan is, and after a purchase asks it to check with RevenueCat right away.
 */

const DEFAULT_API_ORIGIN = 'https://www.nightlink.dev';

/** The configured endpoint, else the configured API host, else nightlink.dev from the iPhone app, else this site. */
export const resolveAccountEndpoint = (env = import.meta.env || {}, isNative = Capacitor.isNativePlatform()) => {
  const endpoint = (env.VITE_ACCOUNT_ENDPOINT || '').trim();
  if (endpoint) return endpoint;
  const base = (env.VITE_API_BASE_URL || '').trim();
  if (base) return `${base.replace(/\/$/, '')}/api/account`;
  if (isNative) return `${DEFAULT_API_ORIGIN}/api/account`;
  return '/api/account';
};

export const ACCOUNT_ENDPOINT = resolveAccountEndpoint();

/**
 * Which plan check this app speaks. The server notes apps that send none
 * (Nightlink 1.3.2, and website tabs from before), and step 3 of the profile
 * privacy rollout waits until there haven't been any for 14 days.
 */
export const CLIENT_SCHEMA = 2;

/**
 * Asks the server for this account's plan. `refresh` asks it to check with
 * RevenueCat now, as right after a purchase or a restore.
 *
 * Resolves { tier, subscription }, or null when there's no answer (offline,
 * signed out, or the check failed), which callers treat as "don't claim
 * anything about this account yet".
 */
export const askServerForPlan = async ({
  accessToken,
  uid,
  refresh = false,
  endpoint = ACCOUNT_ENDPOINT,
  platform = Capacitor.getPlatform(),
  fetchImpl = fetch,
} = {}) => {
  if (!accessToken || !uid) return null;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        action: 'sync_subscription_tier',
        uid,
        clientSchema: CLIENT_SCHEMA,
        platform,
        refresh: refresh === true,
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    if (payload?.tier !== 'premium' && payload?.tier !== 'free') return null;
    const subscription = payload.subscription && typeof payload.subscription === 'object' ? payload.subscription : null;
    return { tier: payload.tier, subscription };
  } catch {
    return null;
  }
};
