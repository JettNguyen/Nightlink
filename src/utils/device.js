/**
 * Whether the app is running on an iPad.
 *
 * Since iPadOS 13 the iPad's web view asks for the desktop site, so its user
 * agent names a Mac and only the touch screen gives it away: no Mac has one.
 * An iPad set to ask for mobile sites still says iPad. Phones, the iPhone Duo
 * included, say iPhone and never match.
 *
 * main.jsx checks this only inside the native app and marks the page with
 * `data-ipad`, which is what ipad.css keys on, so the website never changes.
 */
export function isIpad(nav) {
  const agent = String(nav?.userAgent || '');
  if (/\biPad\b/.test(agent)) return true;
  return /\bMacintosh\b/.test(agent) && Number(nav?.maxTouchPoints || 0) > 1;
}
