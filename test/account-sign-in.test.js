import { test } from 'node:test';
import assert from 'node:assert/strict';
import accountRoute from '../api/account.js';

// Signing in with a username through the server, against a fake Supabase.

const SAM = '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61';
const PASSWORD = 'red-door-1990';
const SAME_ANSWER = 'We could not sign you in. Check your details and try again.';

const fakes = (t, { anon = true, confirmed = true, dbError = null } = {}) => {
  const seen = { lookups: [], signIns: [], logged: [] };
  const admin = {
    from: () => ({
      select: () => ({
        eq: (column, value) => ({
          maybeSingle: async () => {
            seen.lookups.push([column, value]);
            if (dbError) return { data: null, error: { message: dbError } };
            return { data: value === 'sam' ? { id: SAM } : null, error: null };
          },
        }),
      }),
    }),
    auth: {
      admin: {
        // The email Sam signs in with. His profile row says something else.
        getUserById: async (id) => ({ data: { user: id === SAM ? { id, email: 'sam@example.com' } : null }, error: null }),
      },
    },
  };
  const anonClient = {
    auth: {
      signInWithPassword: async ({ email, password }) => {
        seen.signIns.push(email);
        if (email === 'sam@example.com' && password === PASSWORD) {
          if (!confirmed) return { data: { session: null }, error: { message: 'Email not confirmed' } };
          return { data: { session: { access_token: 'access-sam', refresh_token: 'refresh-sam', user: { id: SAM } } }, error: null };
        }
        return { data: { session: null }, error: { message: 'Invalid login credentials' } };
      },
    },
  };
  t.mock.method(accountRoute.deps, 'getSupabaseAdmin', () => admin);
  t.mock.method(accountRoute.deps, 'getSupabaseAnon', () => (anon ? anonClient : null));
  for (const level of ['log', 'error', 'warn']) {
    t.mock.method(console, level, (...args) => { seen.logged.push(args.map(String).join(' ')); });
  }
  return seen;
};

const signIn = async (username, password) => {
  const res = {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  await accountRoute({ method: 'POST', headers: {}, body: { action: 'sign_in_with_username', username, password } }, res);
  return res;
};

test('the right username and password give back a session, signed in with the email Sam signs in with', async (t) => {
  const seen = fakes(t);
  const res = await signIn('  SAM ', PASSWORD);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { session: { access_token: 'access-sam', refresh_token: 'refresh-sam' } });
  assert.deepEqual(seen.lookups, [['normalized_username', 'sam']]);
  assert.deepEqual(seen.signIns, ['sam@example.com']);
  assert.equal(JSON.stringify(res.body).includes('@'), false, 'the email never goes back');
});

test('an unknown username and a wrong password get the same answer', async (t) => {
  const seen = fakes(t);
  const unknown = await signIn('dana', PASSWORD);
  const wrong = await signIn('sam', 'not-it');
  const odd = await signIn('sam@example.com', PASSWORD);
  for (const res of [unknown, wrong, odd]) {
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: SAME_ANSWER, code: 'invalid_credentials' });
  }
  assert.deepEqual(seen.signIns, ['sam@example.com'], 'only a username that exists gets as far as a sign in');
});

test('an unconfirmed email says so, with what to do', async (t) => {
  fakes(t, { confirmed: false });
  const res = await signIn('sam', PASSWORD);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'email_not_confirmed');
  assert.match(res.body.error, /confirm your email/);
});

test('without the public key set, it says to sign in with an email instead', async (t) => {
  const seen = fakes(t, { anon: false });
  const res = await signIn('sam', PASSWORD);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /Sign in with your email instead/);
  assert.ok(seen.logged.some((line) => line.includes('SUPABASE_ANON_KEY')), 'the log names the setting');
});

test('a database error asks to try again, and the password is never logged', async (t) => {
  const seen = fakes(t, { dbError: 'connection reset' });
  const res = await signIn('sam', PASSWORD);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /Try again in a minute/);
  assert.equal(seen.logged.some((line) => line.includes(PASSWORD)), false);
});
