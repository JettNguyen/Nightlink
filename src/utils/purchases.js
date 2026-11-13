/**
 * RevenueCat SDK wrapper for Nightlink.
 *
 * Only active on iOS native (Capacitor). All functions are safe to import on
 * web, so they simply no-op or return sensible defaults when IS_RC_SUPPORTED is
 * false, so callers don't need to guard every call site.
 */

import { Capacitor } from '@capacitor/core';
import { Purchases } from '@revenuecat/purchases-capacitor';
import { RevenueCatUI } from '@revenuecat/purchases-capacitor-ui';

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
 * Present the RC Customer Center, a pre-built sheet where subscribers can
 * cancel, request refunds, and view purchase history.
 * Show this when the user already has an active subscription.
 */
export const presentCustomerCenter = () => RevenueCatUI.presentCustomerCenter();

// Plans and credits bought here reach the account through the server, never
// from the app: RevenueCat tells the server (api/revenuecat.js), and the app
// asks the server to check right after a purchase (askServerForPlan in
// accountApi.js).
