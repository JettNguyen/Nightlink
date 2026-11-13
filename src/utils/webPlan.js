/**
 * Pro bought on nightlink.dev, as Settings on the website shows it.
 *
 * Only the server can say whether an account has a plan bought on the website:
 * it asks Stripe for the subscription stamped with the account's id (the
 * plan_status action in api/stripe.js). The profile row can't say. Its owner can
 * write anything into it, the iPhone app rewrites it with what Apple knows, and
 * a comped account reads as Pro there too.
 *
 * `webPlan` below is the server's answer: true or false, or null while it isn't
 * known yet or the check failed.
 */

/** The Manage plan button: on the website, for an account Stripe has a plan for. */
export function showsManagePlan({ isNativeApp, webPlan }) {
  return !isNativeApp && webPlan === true;
}

/**
 * The line saying where to change Pro bought in the iPhone app, for someone
 * looking at their plan on the website. Not while the server's answer is out,
 * so a plan bought here never gets the iPhone line first.
 */
export function showsIphonePlanNote({ isNativeApp, webPlan, subscription }) {
  return !isNativeApp
    && webPlan === false
    && subscription?.tier === 'premium'
    && subscription?.provider === 'revenuecat';
}
