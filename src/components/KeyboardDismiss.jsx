import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { triggerLightHaptic } from '../utils/haptics';
import Overlay from './Overlay';
import './KeyboardDismiss.css';

/**
 * A Done control that sits just above the keyboard on iOS.
 *
 * The keyboard plugin hides WebKit's form accessory bar, the grey strip that
 * normally carries Done. That is the right call visually, but it leaves a
 * textarea with no way out at all, because Return inserts a newline there
 * rather than submitting.
 *
 * Visibility is pure CSS off the `keyboard-open` class that the keyboard setup
 * puts on <html>, so there is no state here to fall out of sync with it.
 *
 * It portals to <body> like the overlays do. Inside #root, which is its own
 * stacking context at z-index 2, its 1400 could never beat a sheet's 1000, so
 * Done sat hidden under the new dream sheet, the one place it matters most.
 */
export default function KeyboardDismiss() {
  const dismiss = () => {
    void triggerLightHaptic();
    // Blur first: dropping focus is what actually dismisses the keyboard, and
    // hiding it while the field is still focused leaves the caret sitting in a
    // field with no keyboard under it.
    const active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();
    if (Capacitor.isNativePlatform()) {
      Keyboard.hide().catch(() => {
        // Already closing, or the plugin is unavailable, and the blur covers it.
      });
    }
  };

  return (
    <Overlay>
      <button
        type="button"
        className="keyboard-dismiss"
        onClick={dismiss}
        aria-label="Close keyboard"
      >
        <FontAwesomeIcon icon={faChevronDown} />
        <span>Done</span>
      </button>
    </Overlay>
  );
}
