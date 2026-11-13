import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIpad } from './device.js';

// What each web view reports, as seen in the simulators.
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const IPAD_MOBILE = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

test('an iPad asking for desktop sites is found by its touch screen', () => {
  assert.equal(isIpad({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 }), true);
});

test('an iPad asking for mobile sites says so', () => {
  assert.equal(isIpad({ userAgent: IPAD_MOBILE, maxTouchPoints: 5 }), true);
});

test('a phone, the Duo included, is not an iPad', () => {
  assert.equal(isIpad({ userAgent: IPHONE, maxTouchPoints: 5 }), false);
});

test('a Mac is not an iPad', () => {
  assert.equal(isIpad({ userAgent: MAC_SAFARI, maxTouchPoints: 0 }), false);
  assert.equal(isIpad({ userAgent: IPAD_DESKTOP, maxTouchPoints: 0 }), false);
});

test('nothing to go on is not an iPad', () => {
  assert.equal(isIpad(undefined), false);
  assert.equal(isIpad({}), false);
});
