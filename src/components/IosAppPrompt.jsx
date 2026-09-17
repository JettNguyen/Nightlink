import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import useEscapeKey from '../hooks/useEscapeKey';
import Overlay from './Overlay';
import { triggerLightHaptic } from '../utils/haptics';
import './IosAppPrompt.css';

export const APP_STORE_URL =
  'https://apps.apple.com/us/app/nightlink-social/id6768789704?ppid=51e85a05-3f4b-4016-a6f3-34fd77ba46df';

const DISMISS_KEY = 'nightlink_ios_app_prompt';

// Long enough that the prompt arrives after the page has settled, short enough
// that it still reads as part of the same moment.
const SHOW_DELAY_MS = 1400;

// localStorage throws outright in some privacy modes. Failing open there shows
// the prompt again on the next visit, which is the gentler of the two misses.
function wasDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function markDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // Nothing to fall back on. Worst case the prompt shows once more.
  }
}

/**
 * True on an iPhone or iPad running the site in a browser.
 *
 * Inside the shipped app Capacitor reports a native platform, so the prompt
 * never points someone at a store page for the app they are already in. iPadOS
 * 13 and up sends the desktop Safari user agent, and the only tell left is a
 * Mac that takes touch.
 */
function isIosBrowser() {
  if (Capacitor.isNativePlatform()) return false;
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

export default function IosAppPrompt() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isIosBrowser() || wasDismissed()) return undefined;
    const timer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const close = () => {
    markDismissed();
    setVisible(false);
  };

  useEscapeKey(close, visible);

  if (!visible) return null;

  return (
    <Overlay>
      <div
        className="ios-app-prompt-backdrop"
        onClick={close}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ios-app-prompt-title"
      >
        <div className="ios-app-prompt" onClick={(e) => e.stopPropagation()}>
          <img className="ios-app-prompt-icon" src="/AppIcon-1024.png" alt="" />
          <h3 className="ios-app-prompt-title" id="ios-app-prompt-title">
            Nightlink is on your iPhone
          </h3>
          <p className="ios-app-prompt-message">
            The same journal, ready the moment you wake up, with a nightly reminder
            to write your dream down before it fades.
          </p>
          <div className="ios-app-prompt-actions">
            <button type="button" className="secondary-btn" onClick={close}>
              Not now
            </button>
            <a
              className="primary-btn ios-app-prompt-get"
              href={APP_STORE_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                void triggerLightHaptic();
                close();
              }}
            >
              Get the app
            </a>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
