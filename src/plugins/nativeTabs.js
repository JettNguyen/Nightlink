import { registerPlugin, Capacitor } from '@capacitor/core';

/**
 * Bridge to `AppShell.swift`, which puts the five tabs in a UIKit tab bar, or
 * in a sidebar where the screen is wide enough for one (the open iPhone Duo).
 *
 * The shell registers the plugin only on iOS 18 and later, and before the
 * page's first script runs, so this check is synchronous and settles once.
 * Where it is false, Navigation draws its own bar as before.
 */
const NativeTabs = registerPlugin('NativeTabs');

export const nativeTabsActive = Capacitor.isPluginAvailable('NativeTabs');

/** Tab ids on the native side, keyed by the route each one opens. */
export const NATIVE_TAB_IDS = {
  '/journal': 'journal',
  '/feed': 'feed',
  '/search': 'search',
  '/activity': 'activity',
  '/profile': 'profile',
};

export const NATIVE_TAB_PATHS = Object.fromEntries(
  Object.entries(NATIVE_TAB_IDS).map(([path, id]) => [id, path])
);

// The bar shows while Navigation is mounted (someone is signed in) and no full
// screen overlay is open, since it would sit over the bottom of a sheet.
let shown = false;
let covers = 0;

const sendVisibility = () => {
  if (!nativeTabsActive) return;
  NativeTabs.update({ visible: shown && covers === 0 }).catch(() => {});
};

export const setNativeTabsShown = (value) => {
  shown = value;
  sendVisibility();
};

/** Hides the bar until the returned function is called. */
export const coverNativeTabs = () => {
  covers += 1;
  sendVisibility();
  return () => {
    covers -= 1;
    sendVisibility();
  };
};

export const updateNativeTabs = (options) => {
  if (!nativeTabsActive) return;
  NativeTabs.update(options).catch(() => {});
};

/** `handler({ id, reselect })` runs when a tab is tapped. Returns a remover. */
export const onNativeTabSelect = (handler) => {
  if (!nativeTabsActive) return () => {};
  const listener = NativeTabs.addListener('select', handler);
  return () => { void listener.then((l) => l.remove()); };
};
