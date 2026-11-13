import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showsManagePlan, showsIphonePlanNote } from './webPlan.js';

const APP_STORE_PRO = { tier: 'premium', provider: 'revenuecat', expiresAt: '2026-12-13T00:00:00Z' };

test('Manage plan shows only for web subscribers, on the website', () => {
  assert.equal(showsManagePlan({ isNativeApp: false, webPlan: true }), true);

  // No plan bought here, or no answer yet.
  assert.equal(showsManagePlan({ isNativeApp: false, webPlan: false }), false);
  assert.equal(showsManagePlan({ isNativeApp: false, webPlan: null }), false);
  assert.equal(showsManagePlan({ isNativeApp: false, webPlan: undefined }), false);
  assert.equal(showsManagePlan({ isNativeApp: false, webPlan: 'true' }), false);

  // Never in the iPhone app, which keeps Apple's own way of managing a plan.
  assert.equal(showsManagePlan({ isNativeApp: true, webPlan: true }), false);
});

test('the profile alone never shows Manage plan', () => {
  for (const subscription of [{ tier: 'premium' }, { tier: 'premium', provider: 'stripe' }, APP_STORE_PRO]) {
    assert.equal(showsManagePlan({ isNativeApp: false, webPlan: null, subscription }), false);
    assert.equal(showsManagePlan({ isNativeApp: false, webPlan: false, subscription }), false);
  }
});

test('the iPhone line shows for Pro from the App Store, once the server says there is no web plan', () => {
  assert.equal(showsIphonePlanNote({ isNativeApp: false, webPlan: false, subscription: APP_STORE_PRO }), true);

  assert.equal(showsIphonePlanNote({ isNativeApp: false, webPlan: null, subscription: APP_STORE_PRO }), false);
  assert.equal(showsIphonePlanNote({ isNativeApp: false, webPlan: true, subscription: APP_STORE_PRO }), false);
  assert.equal(showsIphonePlanNote({ isNativeApp: true, webPlan: false, subscription: APP_STORE_PRO }), false);
  assert.equal(showsIphonePlanNote({ isNativeApp: false, webPlan: false, subscription: { ...APP_STORE_PRO, tier: 'free' } }), false);
  assert.equal(showsIphonePlanNote({ isNativeApp: false, webPlan: false, subscription: { tier: 'premium' } }), false);
  assert.equal(showsIphonePlanNote({ isNativeApp: false, webPlan: false, subscription: null }), false);
});
