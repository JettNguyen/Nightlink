/**
 * RevenueCat SDK wrapper for Nightlink.
 *
 * Only active on iOS native (Capacitor). All functions are safe to import on
 * web, so they simply no-op or return sensible defaults when IS_RC_SUPPORTED is
 * false, so callers don't need to guard every call site.
 */

import { Capacitor } from '@capacitor/core';
import { Purchases } from '@revenuecat/purchases-capacitor';
import { RevenueCatUI, PAYWALL_RESULT } from '@revenuecat/purchases-capacitor-ui';
import { supabase } from '../supabase';

/** The RevenueCat entitlement identifier for Nightlink Pro. */
export const ENTITLEMENT_PRO = 'Nightlink Pro';

/**
 * The RC offering identifier for the 10-credit one-time pack.
 * Configure this offering in the RevenueCat dashboard with your
 * consumable IAP product attached.
 */
export const CREDITS_OFFERING_ID = 'ai_credits';

/** How many AI credits one credit-pack purchase grants. */
export const CREDITS_PER_PACK = 10;

/** API key read from env; falls back to the provided test key. */
export const RC_API_KEY =
  import.meta.env.VITE_REVENUECAT_IOS_API_KEY || 'test_rGlzaAAgFfXRiyYnJQZivprjPEX';

/** True only on native iOS, the only platform where IAP is available. */
export const IS_RC_SUPPORTED =
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

/** Re-export so callers can compare paywall outcomes without extra imports. */
export { PAYWALL_RESULT };

/** Returns true if the supplied CustomerInfo has an active Pro entitlement. */
export const isProFromCustomerInfo = (customerInfo) =>
  !!customerInfo?.entitlements?.active?.[ENTITLEMENT_PRO];

/**
 * Configure the RC SDK with the current user's ID.
 * Safe to call multiple times, since RC de-dupes if already configured with the
 * same user.
 */
export const configurePurchases = async (appUserID) => {
  if (!IS_RC_SUPPORTED || !RC_API_KEY) return;
  await Purchases.configure({ apiKey: RC_API_KEY, appUserID });
};

/** Fetch the latest CustomerInfo for the current user. */
export const getCustomerInfo = async () => {
  const { customerInfo } = await Purchases.getCustomerInfo();
  return customerInfo;
};

/**
 * Register a listener that fires whenever RC detects a customer info change
 * (e.g. subscription renewal, cancellation, grace period).
 *
 * Returns the raw callbackId string; pass it to
 * removeCustomerInfoUpdateListener to clean up.
 */
export const addCustomerInfoUpdateListener = async (callback) =>
  Purchases.addCustomerInfoUpdateListener(callback);

/** Remove a previously registered customer info listener by its callback ID. */
export const removeCustomerInfoUpdateListener = async (callbackId) =>
  Purchases.removeCustomerInfoUpdateListener({ listenerToRemove: callbackId });

/** Fetch all configured offerings from the RC dashboard. */
export const getOfferings = async () => Purchases.getOfferings();

/** Purchase a specific RC Package object (obtained from getOfferings). */
export const purchasePackage = async (aPackage) => {
  const { customerInfo } = await Purchases.purchasePackage({ aPackage });
  return customerInfo;
};

/**
 * Restore previous App Store purchases for the current user.
 * Required by App Store guidelines, so it must be accessible in the UI.
 */
export const restorePurchases = async () => {
  const { customerInfo } = await Purchases.restorePurchases();
  return customerInfo;
};

/**
 * Present the RC paywall only if the user doesn't already have Pro.
 * Returns a PaywallResult with a `result` field (PAYWALL_RESULT enum).
 */
export const presentPaywallIfNeeded = () =>
  RevenueCatUI.presentPaywallIfNeeded({
    requiredEntitlementIdentifier: ENTITLEMENT_PRO,
  });

/**
 * Always present the full RC paywall (e.g. to let a Pro user see options,
 * buy credits, or explore plans).
 */
export const presentPaywall = () => RevenueCatUI.presentPaywall();

/**
 * Present the RC Customer Center, a pre-built sheet where subscribers can
 * cancel, request refunds, and view purchase history.
 * Show this when the user already has an active subscription.
 */
export const presentCustomerCenter = () => RevenueCatUI.presentCustomerCenter();

/**
 * Write the current RC subscription state into the user's Supabase profile.
 * Called after any purchase, restore, or customer-info update so that the
 * rest of the app (AI quota checks, prompt locking, etc.) stays in sync.
 */
export const syncCustomerInfoToSupabase = async (uid, customerInfo) => {
  if (!uid || !customerInfo) return;

  const pro = isProFromCustomerInfo(customerInfo);
  const entitlement = customerInfo.entitlements?.active?.[ENTITLEMENT_PRO];

  const { error } = await supabase
    .from('profiles')
    .update({
      subscription: {
        tier: pro ? 'premium' : 'free',
        provider: 'revenuecat',
        expiresAt: entitlement?.expirationDate ?? null,
        updatedAt: new Date().toISOString(),
      },
    })
    .eq('id', uid);

  if (error) console.error('RC → Supabase sync failed:', error.message);
};

/**
 * Atomically add AI credits to the user's profile after a successful
 * credit-pack purchase.
 */
export const addCreditsToSupabase = async (uid, amount = CREDITS_PER_PACK) => {
  if (!uid) return;

  const { data, error } = await supabase
    .from('profiles')
    .select('ai_usage')
    .eq('id', uid)
    .single();

  if (error) {
    console.error('Credits load failed:', error.message);
    return;
  }

  const nextUsage = {
    ...(data?.ai_usage || {}),
    creditBalance: Number(data?.ai_usage?.creditBalance || 0) + amount,
  };

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ ai_usage: nextUsage })
    .eq('id', uid);

  if (updateError) console.error('Credits update failed:', updateError.message);
};
