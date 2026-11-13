import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASKED_VERSION_KEY, askForReviewIfDue, shouldAskForReview } from './appReview.js';

const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
};

// The app's side of things, counting what gets touched.
const phone = ({ version = '1.3.2', storage = memoryStorage(), isNativeIOS = true } = {}) => {
  const calls = { version: 0, storage: 0, ask: 0 };
  return {
    calls,
    storage,
    after: (savedDreams) => ({
      isNativeIOS,
      savedDreams,
      getAppVersion: async () => {
        calls.version += 1;
        return version;
      },
      getStorage: () => {
        calls.storage += 1;
        return storage;
      },
      ask: async () => {
        calls.ask += 1;
      },
    }),
  };
};

test('the rule: the iPhone app, three or more saved dreams, once per version', () => {
  const due = { isNativeIOS: true, savedDreams: 3, appVersion: '1.3.2', askedVersion: null };
  assert.equal(shouldAskForReview(due), true);
  assert.equal(shouldAskForReview({ ...due, savedDreams: 40 }), true);
  assert.equal(shouldAskForReview({ ...due, askedVersion: '1.3.1' }), true);

  assert.equal(shouldAskForReview({ ...due, savedDreams: 2 }), false);
  assert.equal(shouldAskForReview({ ...due, savedDreams: undefined }), false);
  assert.equal(shouldAskForReview({ ...due, askedVersion: '1.3.2' }), false);
  assert.equal(shouldAskForReview({ ...due, isNativeIOS: false }), false);
  assert.equal(shouldAskForReview({ ...due, appVersion: '' }), false);
});

test('asks right after the third saved dream, then not again in the same version', async () => {
  const app = phone();
  assert.equal(await askForReviewIfDue(app.after(1)), false);
  assert.equal(await askForReviewIfDue(app.after(2)), false);
  assert.equal(app.calls.ask, 0);

  assert.equal(await askForReviewIfDue(app.after(3)), true);
  assert.equal(app.calls.ask, 1);
  assert.equal(app.storage.getItem(ASKED_VERSION_KEY), '1.3.2');

  assert.equal(await askForReviewIfDue(app.after(4)), false);
  assert.equal(await askForReviewIfDue(app.after(5)), false);
  assert.equal(app.calls.ask, 1);
});

test('asks again in the next app version', async () => {
  const app = phone({ version: '1.4', storage: memoryStorage({ [ASKED_VERSION_KEY]: '1.3.2' }) });
  assert.equal(await askForReviewIfDue(app.after(12)), true);
  assert.equal(app.calls.ask, 1);
});

test('never asks on the web, and touches neither storage nor the native side there', async () => {
  const app = phone({ isNativeIOS: false });
  assert.equal(await askForReviewIfDue(app.after(10)), false);
  assert.deepEqual(app.calls, { version: 0, storage: 0, ask: 0 });
});

test('does not ask when storage is unavailable, since once per version could not be kept', async () => {
  const app = phone();
  const unavailable = {
    ...app.after(3),
    getStorage: () => {
      throw new Error('The operation is insecure.');
    },
  };
  assert.equal(await askForReviewIfDue(unavailable), false);
  assert.equal(app.calls.ask, 0);
});

test('a prompt that fails still counts as asked, and the failure never reaches the caller', async () => {
  const app = phone();
  const failing = {
    ...app.after(3),
    ask: async () => {
      throw new Error('No active window scene.');
    },
  };
  assert.equal(await askForReviewIfDue(failing), false);
  assert.equal(app.storage.getItem(ASKED_VERSION_KEY), '1.3.2');
  assert.equal(await askForReviewIfDue(app.after(4)), false);
  assert.equal(app.calls.ask, 0);
});
