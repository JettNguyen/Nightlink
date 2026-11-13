import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askServerForPlan, CLIENT_SCHEMA, resolveAccountEndpoint } from './accountApi.js';

const SAM = '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61';

const server = (answer, { ok = true } = {}) => {
  const sent = [];
  const fetchImpl = async (url, options) => {
    sent.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    if (answer instanceof Error) throw answer;
    return { ok, json: async () => answer };
  };
  return { sent, fetchImpl };
};

test('the plan check says which version of it this app speaks, so the server can tell 1.3.2 apart', async () => {
  const { sent, fetchImpl } = server({ success: true, tier: 'premium', subscription: { tier: 'premium', sources: { web: { active: true } } } });
  const plan = await askServerForPlan({ accessToken: 'token', uid: SAM, refresh: true, endpoint: '/api/account', platform: 'ios', fetchImpl });

  assert.deepEqual(sent[0].body, { action: 'sync_subscription_tier', uid: SAM, clientSchema: CLIENT_SCHEMA, platform: 'ios', refresh: true });
  assert.equal(sent[0].headers.Authorization, 'Bearer token');
  assert.equal(CLIENT_SCHEMA, 2);
  assert.deepEqual(plan, { tier: 'premium', subscription: { tier: 'premium', sources: { web: { active: true } } } });
});

test('no answer is null, never free', async () => {
  const ask = (fake) => askServerForPlan({ accessToken: 'token', uid: SAM, endpoint: '/api/account', platform: 'web', fetchImpl: fake.fetchImpl });
  assert.equal(await ask(server(new Error('offline'))), null);
  assert.equal(await ask(server({ error: 'Failed to sync subscription tier.' }, { ok: false })), null);
  assert.equal(await ask(server({ success: true })), null);
  assert.equal(await askServerForPlan({ uid: SAM, fetchImpl: server({ tier: 'free' }).fetchImpl }), null, 'signed out');
  assert.deepEqual(await ask(server({ success: true, tier: 'free' })), { tier: 'free', subscription: null });
});

test('the account route is found the way every page found it before', () => {
  assert.equal(resolveAccountEndpoint({ VITE_ACCOUNT_ENDPOINT: ' https://example.com/x ' }, false), 'https://example.com/x');
  assert.equal(resolveAccountEndpoint({ VITE_API_BASE_URL: 'https://example.com/' }, true), 'https://example.com/api/account');
  assert.equal(resolveAccountEndpoint({}, true), 'https://www.nightlink.dev/api/account');
  assert.equal(resolveAccountEndpoint({}, false), '/api/account');
});
