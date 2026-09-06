import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

const isNativeIOS = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

const run = async (fn) => {
  if (!isNativeIOS()) return;

  try {
    await fn();
  } catch {
    // Ignore haptic failures so UI interactions still complete.
  }
};

const triggerImpact = (style = ImpactStyle.Light) => run(() => Haptics.impact({ style }));

/** Taps: navigation, buttons, opening things. */
export const triggerLightHaptic = () => triggerImpact(ImpactStyle.Light);
/** Committing something: saving, posting, completing a pull-to-refresh. */
export const triggerMediumHaptic = () => triggerImpact(ImpactStyle.Medium);
/** Rare, weighty moments: deleting, or a destructive confirm landing. */
export const triggerHeavyHaptic = () => triggerImpact(ImpactStyle.Heavy);

/**
 * Notification haptics are the ones that make an app feel responsive: iOS uses
 * a distinct double-tap pattern for success and failure, so an action that
 * worked feels different in the hand from one that did not.
 */
export const triggerSuccessHaptic = () => run(() => Haptics.notification({ type: NotificationType.Success }));
export const triggerWarningHaptic = () => run(() => Haptics.notification({ type: NotificationType.Warning }));
export const triggerErrorHaptic = () => run(() => Haptics.notification({ type: NotificationType.Error }));

/** Moving between discrete options: tabs, segmented controls, chips, toggles. */
export const triggerSelectionHaptic = () => run(() => Haptics.selectionChanged());
