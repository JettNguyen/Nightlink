/**
 * Pro bought on nightlink.dev, as Settings on the website shows it.
 *
 * Only the server can say whether an account has a plan bought on the website:
 * it asks Stripe for the subscription stamped with the account's id (the
 * plan_status action in api/stripe.js). The profile row isn't enough: a plan
 * bought through an old payment link isn't on it until it's linked, and until
 * step 2 of the profile privacy rollout its owner can still write it.
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
 *
 * A plan keeps a part per source (subscription.sources); the line is for the
 * App Store part. A plan from before sources only has provider to go on.
 */
export function showsIphonePlanNote({ isNativeApp, webPlan, subscription }) {
  if (isNativeApp || webPlan !== false || subscription?.tier !== 'premium') return false;
  const sources = subscription?.sources;
  if (sources && typeof sources === 'object') return sources.apple?.active === true;
  return subscription?.provider === 'revenuecat';
}
