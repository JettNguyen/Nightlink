import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';

/**
 * Flags the native keyboard on the document so CSS can react to it.
 *
 * `resize: 'native'` shrinks the WKWebView itself, which keeps a focused input
 * visible for free but also drags every `position: fixed` bottom element up to
 * sit on top of the keyboard. A real iOS tab bar is covered by the keyboard
 * rather than pushed above it, so the web layer needs to know when to get out
 * of the way.
 */
export default function setupKeyboard() {
  if (!(Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios')) return;

  const setOpen = (open) => {
    document.documentElement.classList.toggle('keyboard-open', open);
  };

  const listen = (event, handler) => {
    Keyboard.addListener(event, handler).catch(() => {
      // Plugin unavailable, so the app just keeps the plain web behaviour.
    });
  };

  // The plugin reports 0 for the bare QuickType bar, which resizes nothing,
  // treating that as "open" would hide the tab bar for no reason.
  listen('keyboardWillShow', (info) => setOpen((info?.keyboardHeight || 0) > 0));
  listen('keyboardWillHide', () => setOpen(false));
}
