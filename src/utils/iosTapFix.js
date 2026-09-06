/**
 * iOS scroll-tap fix.
 *
 * On iOS WKWebView, touchstart immediately marks an element as :active (and
 * often triggers :hover), even if the touch turns into a scroll gesture. This
 * makes cards and buttons flash highlights while the user is just trying to
 * scroll.
 *
 * The fix: add `is-scrolling` to <html> as soon as movement exceeds
 * SCROLL_THRESHOLD px AND the touch has been held for at least MIN_HOLD_MS.
 * The short hold guard prevents fast deliberate taps from being misclassified
 * as scrolls. The class is removed on touchend/touchcancel so intentional
 * taps still get full feedback.
 *
 * CSS scoped to `html[data-native-platform='ios'].is-scrolling` suppresses
 * hover/active visual changes for the duration. Web is unaffected.
 *
 * Only installs when data-native-platform="ios" (set by main.jsx).
 */

const SCROLL_THRESHOLD = 6;  // px of movement before treating as scroll
const MIN_HOLD_MS = 80;       // ms; taps faster than this are never scrolls

export function initIosTapFix() {
  if (document.documentElement.dataset.nativePlatform !== 'ios') {
    return () => {};
  }

  const html = document.documentElement;
  let startY = 0;
  let startX = 0;
  let startTime = 0;
  let tracking = false;
  let scrolling = false;

  const setScrolling = (value) => {
    if (scrolling === value) return;
    scrolling = value;
    if (value) {
      html.classList.add('is-scrolling');
    } else {
      html.classList.remove('is-scrolling');
    }
  };

  const onTouchStart = (e) => {
    if (!e.touches || e.touches.length !== 1) {
      setScrolling(false);
      tracking = false;
      return;
    }
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    startTime = Date.now();
    tracking = true;
    setScrolling(false);
  };

  const onTouchMove = (e) => {
    if (!tracking) return;
    if (!e.touches || e.touches.length !== 1) return;
    if (Date.now() - startTime < MIN_HOLD_MS) return;
    const dy = Math.abs(e.touches[0].clientY - startY);
    const dx = Math.abs(e.touches[0].clientX - startX);
    if (dy > SCROLL_THRESHOLD || dx > SCROLL_THRESHOLD) {
      setScrolling(true);
    }
  };

  const onTouchEnd = () => {
    tracking = false;
    setScrolling(false);
  };

  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true });
  window.addEventListener('touchend', onTouchEnd, { passive: true });
  window.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return () => {
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchEnd);
    html.classList.remove('is-scrolling');
  };
}
