import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import useEscapeKey from '../hooks/useEscapeKey';
import Overlay from './Overlay';
import { triggerLightHaptic } from '../utils/haptics';
import './IosAppPrompt.css';

export const APP_STORE_URL =
  'https://apps.apple.com/us/app/nightlink-social/id6768789704?ppid=51e85a05-3f4b-4016-a6f3-34fd77ba46df';

// The newest APK on the repo's releases. GitHub keeps this link pointing at
// the latest one, so a new release needs no change here.
export const ANDROID_APK_URL =
  'https://github.com/JettNguyen/Nightlink/releases/latest/download/Nightlink.apk';

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
 * `ios` on an iPhone or iPad running the site in a browser, `android` on an
 * Android phone or tablet, and null anywhere else.
 *
 * Inside the shipped apps Capacitor reports a native platform, so the prompt
 * never points someone at the app they are already in. iPadOS 13 and up sends
 * the desktop Safari user agent, and the only tell left is a Mac that takes
 * touch.
 */
function browserPlatform() {
  if (Capacitor.isNativePlatform()) return null;
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return null;
}

// The Android app is a file from the repo's releases, not a Play Store
// listing, so its card says how to install one.
const COPY = {
  ios: {
    title: 'Nightlink is on your iPhone',
    message: 'The same journal, ready the moment you wake up, with a nightly reminder to write your dream down before it fades.',
    action: 'Get the app',
    href: APP_STORE_URL,
  },
  android: {
    title: 'Nightlink is on Android',
    message: 'The same journal, ready the moment you wake up. It downloads as a file, not from the Play Store: open it when it finishes, and let your browser install it if Android asks.',
    action: 'Download',
    href: ANDROID_APK_URL,
  },
};

export default function IosAppPrompt() {
  const [platform, setPlatform] = useState(null);
  const visible = platform !== null;

  useEffect(() => {
    const found = browserPlatform();
    if (!found || wasDismissed()) return undefined;
    const timer = setTimeout(() => setPlatform(found), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const close = () => {
    markDismissed();
    setPlatform(null);
  };

  useEscapeKey(close, visible);

  if (!visible) return null;
  const copy = COPY[platform];

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
            {copy.title}
          </h3>
          <p className="ios-app-prompt-message">{copy.message}</p>
          <div className="ios-app-prompt-actions">
            <button type="button" className="secondary-btn" onClick={close}>
              Not now
            </button>
            <a
              className="primary-btn ios-app-prompt-get"
              href={copy.href}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                void triggerLightHaptic();
                close();
              }}
            >
              {copy.action}
            </a>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
