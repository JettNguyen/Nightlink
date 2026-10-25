import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './App';
import setupKeyboard from './utils/keyboard';
import { nativeTabsActive } from './plugins/nativeTabs';
import './index.css';

// When a lazy chunk 404s after a new deployment, reload once to pick up the new index.html.
window.addEventListener('vite:preloadError', () => {
  const key = 'vite_reload_attempted';
  if (!sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, '1');
    window.location.reload();
  }
});

if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios') {
  document.documentElement.dataset.nativePlatform = 'ios';
  // The tab bar is UIKit's (AppShell.swift), and the page leaves room for it
  // through the bottom safe area inset rather than a fixed height.
  if (nativeTabsActive) document.documentElement.dataset.nativeTabs = '';

  setupKeyboard();

  // Native app shell should not be controlled by a web service worker.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
