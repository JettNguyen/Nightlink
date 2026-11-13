import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { InAppReview } from '@capacitor-community/in-app-review';

/**
 * Asks for an App Store rating with Apple's own prompt, in the iPhone app only.
 *
 * The moment is right after a saved dream brings the account to three or more,
 * so someone who already had three when this shipped is asked after their next
 * one. The count is the account's, from the journal, so dreams written on the
 * website count too. It asks at most once per app version, and Apple decides
 * whether the prompt really shows: no more than three times a year, and never
 * in a TestFlight build.
 */

export const DREAMS_BEFORE_ASKING = 3;
export const ASKED_VERSION_KEY = 'nightlink_review_asked_version';

// Long enough for the new dream sheet to close and the entry to land in the
// list, so the prompt reads as part of the same moment.
const ASK_DELAY_MS = 700;

const IS_NATIVE_IOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

/** The rule on its own: the iPhone app, three or more saved dreams, not yet asked in this version. */
export function shouldAskForReview({ isNativeIOS, savedDreams, appVersion, askedVersion }) {
  if (!isNativeIOS || !appVersion) return false;
  if (!(savedDreams >= DREAMS_BEFORE_ASKING)) return false;
  return askedVersion !== appVersion;
}

/**
 * Applies the rule and asks when it says to. Everything it touches is passed in,
 * so it can be tested away from a phone. Resolves to whether it asked, and never
 * rejects, because a rating prompt is not worth breaking a save over.
 */
export async function askForReviewIfDue({ isNativeIOS, savedDreams, getAppVersion, getStorage, ask }) {
  // Settled before storage or the native side is touched, so the website does neither.
  if (!isNativeIOS || !(savedDreams >= DREAMS_BEFORE_ASKING)) return false;
  try {
    const storage = getStorage();
    const askedVersion = storage.getItem(ASKED_VERSION_KEY);
    const appVersion = await getAppVersion();
    if (!shouldAskForReview({ isNativeIOS, savedDreams, appVersion, askedVersion })) return false;
    // Written first, so nothing that goes wrong below can lead to a second ask in this version.
    storage.setItem(ASKED_VERSION_KEY, appVersion);
    await ask();
    return true;
  } catch {
    // Storage that throws, a version that can't be read, or a prompt that fails.
    // Without storage there is no keeping to once per version, so not asking is
    // the right miss.
    return false;
  }
}

/** Call after a dream saves, with how many saved dreams the account now has. */
export const askForReviewAfterSave = (savedDreams) => askForReviewIfDue({
  isNativeIOS: IS_NATIVE_IOS,
  savedDreams,
  getAppVersion: async () => (await App.getInfo()).version,
  getStorage: () => window.localStorage,
  ask: async () => {
    await new Promise((resolve) => { setTimeout(resolve, ASK_DELAY_MS); });
    await InAppReview.requestReview();
  },
});
