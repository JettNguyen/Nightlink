/**
 * Pinch zoom on the website, none in the iPhone app.
 *
 * index.html leaves zoom on, because a website that blocks it keeps people who
 * need bigger text from getting it (WCAG 1.4.4). The app is its own screen, laid
 * out to fit the phone the way a native one is, so there the lock goes back on.
 * main.jsx calls this before the first render, while the splash screen is still
 * up, so the app is never seen without it.
 */

const LOCK = ['maximum-scale=1.0', 'user-scalable=no'];
const LOCK_NAMES = new Set(['maximum-scale', 'user-scalable']);

/** The viewport content with zoom locked, and every other setting left as it was. */
export function lockedViewportContent(content) {
  const kept = String(content || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !LOCK_NAMES.has(part.split('=')[0].trim().toLowerCase()));
  return [...kept, ...LOCK].join(', ');
}

/**
 * Locks zoom inside the native app and leaves the website alone. Pass
 * `Capacitor.isNativePlatform()` as `isNativeApp`. Returns whether it locked.
 */
export function lockZoomInNativeApp(doc, isNativeApp) {
  if (!isNativeApp) return false;
  const meta = doc.querySelector('meta[name="viewport"]');
  if (!meta) return false;
  meta.setAttribute('content', lockedViewportContent(meta.getAttribute('content')));
  return true;
}
