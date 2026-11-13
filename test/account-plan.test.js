import { test } from 'node:test';
import assert from 'node:assert/strict';
import accountRoute from '../api/account.js';
import aiRoute from '../api/ai.js';

// The account route's plan check and reports, and the AI route's tier and
// dream memory, against a fake Supabase and a fake RevenueCat. Nothing leaves
// this machine.

const SAM = '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61';
const DANA = 'f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42';
const COMP_LIST = 'dana@example.com, Jett@Example.com';

const USERS = {
  'token-sam': { id: SAM, email: 'sam@example.com' },
  'token-dana': { id: DANA, email: 'dana@example.com' },
};

// What the database works out, as supabase/rollout/1-profile-privacy-add.sql does.
const withSource = (plan, source, state) => {
  const sources = { ...(plan?.sources || {}), [source]: state };
  if (source === 'web' && state.active === true && sources.legacy?.active === true) {
    sources.legacy = { ...sources.legacy, active: false, endedBy: 'web' };
  }
  const active = Object.values(sources).some((part) => part?.active === true);
  return { ...plan, sources, tier: active ? 'premium' : 'free' };
};

const MISSING = { code: 'PGRST202', message: 'Could not find the function public.whatever' };

const fakeSupabase = ({ rows, beforeStep1 = false } = {}) => {
  const profiles = structuredClone(rows);
  const calls = [];
  const admin = {
    auth: {
      getUser: async (token) => {
        const user = USERS[token];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad token' } };
      },
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (beforeStep1) return { data: null, error: MISSING };
      if (name === 'note_old_app') return { data: null, error: null };
      if (name === 'set_plan_source') {
        const row = profiles[args.p_user_id];
        if (!row) return { data: null, error: null };
        row.subscription = withSource(row.subscription, args.p_source, args.p_state);
        return { data: row.subscription, error: null };
      }
      if (name === 'add_safety_report') return { data: null, error: null };
      if (name === 'get_dream_memory') return { data: profiles[args.p_user_id]?.private_memory ?? null, error: null };
      if (name === 'save_dream_memory') {
        profiles[args.p_user_id].private_memory = args.p_memory;
        return { data: null, error: null };
      }
      return { data: null, error: MISSING };
    },
    from: (table) => {
      assert.equal(table, 'profiles');
      return {
        select: (columns) => ({
          eq: (_column, id) => ({
            single: async () => {
              calls.push({ name: 'select', columns, id });
              const row = profiles[id];
              if (!row) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
              return { data: Object.fromEntries(columns.split(',').map((c) => [c.trim(), row[c.trim()]])), error: null };
            },
          }),
        }),
        update: (patch) => ({
          eq: async (_column, id) => {
            calls.push({ name: 'update', patch, id });
            Object.assign(profiles[id], patch);
            return { error: null };
          },
        }),
      };
    },
  };
  return { admin, calls, profiles };
};

const withFakes = (t, options) => {
  const supabase = fakeSupabase(options);
  t.mock.method(accountRoute.deps, 'getSupabaseAdmin', () => supabase.admin);
  t.mock.method(aiRoute.deps, 'getSupabaseAdmin', () => supabase.admin);
  t.mock.method(console, 'error', () => {});
  const saved = { comp: process.env.PREMIUM_EMAILS, rc: process.env.REVENUECAT_SECRET_KEY };
  process.env.PREMIUM_EMAILS = COMP_LIST;
  delete process.env.REVENUECAT_SECRET_KEY;
  t.after(() => {
    for (const [name, value] of [['PREMIUM_EMAILS', saved.comp], ['REVENUECAT_SECRET_KEY', saved.rc]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return supabase;
};

const call = async (body, token = 'token-sam') => {
  const res = {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  await accountRoute({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, res);
  return res;
};

const sync = (uid, extra = {}, token) => call({ action: 'sync_subscription_tier', uid, ...extra }, token);
const NEXT_APP = { clientSchema: 2, platform: 'web' };
const named = (supabase, name) => supabase.calls.filter((c) => c.name === name).map((c) => c.args);

test('the comp list matches the email someone signs in with, not the one on their profile', async (t) => {
  const supabase = withFakes(t, {
    rows: {
      // Sam put a listed email on his profile, which apps can write.
      [SAM]: { email: 'dana@example.com', subscription: { tier: 'free', sources: {} } },
      [DANA]: { email: 'dana@example.com', subscription: { tier: 'free', sources: {} } },
    },
  });

  const sam = await sync(SAM, NEXT_APP);
  assert.equal(sam.statusCode, 200);
  assert.equal(sam.body.tier, 'free');
  assert.equal(named(supabase, 'set_plan_source').length, 0);

  const dana = await sync(DANA, NEXT_APP, 'token-dana');
  assert.equal(dana.body.tier, 'premium');
  assert.equal(dana.body.success, true, '1.3.2 reads success and tier');
  assert.deepEqual(named(supabase, 'set_plan_source').map((a) => [a.p_user_id, a.p_source, a.p_state.active]), [[DANA, 'comp', true]]);
  assert.equal(dana.body.subscription.sources.comp.active, true);

  await sync(DANA, NEXT_APP, 'token-dana');
  assert.equal(named(supabase, 'set_plan_source').length, 1, 'nothing to change the second time');
});

test('taking an email off the list ends the comp part and nothing else', async (t) => {
  const supabase = withFakes(t, {
    rows: {
      [SAM]: { subscription: { tier: 'premium', sources: { web: { active: true }, comp: { active: true } } } },
      [DANA]: { subscription: { tier: 'premium', sources: { comp: { active: true } } } },
    },
  });
  process.env.PREMIUM_EMAILS = '';

  assert.equal((await sync(SAM, NEXT_APP)).body.tier, 'premium', 'still paying on the website');
  assert.equal((await sync(DANA, NEXT_APP, 'token-dana')).body.tier, 'free');
  assert.deepEqual(named(supabase, 'set_plan_source').map((a) => [a.p_user_id, a.p_source, a.p_state.active]), [
    [SAM, 'comp', false],
    [DANA, 'comp', false],
  ]);
  assert.equal(supabase.profiles[SAM].subscription.sources.web.active, true);
});

test('an app from before plans had sources is noted for step 3, and the next version is not', async (t) => {
  const supabase = withFakes(t, { rows: { [SAM]: { subscription: { tier: 'free', sources: {} } } } });
  await sync(SAM);
  await sync(SAM, NEXT_APP);
  assert.deepEqual(named(supabase, 'note_old_app'), [{ p_user_id: SAM }]);
});

test('before step 1 of the rollout it works as it always did: the comp list adds Pro and never takes it away', async (t) => {
  const supabase = withFakes(t, {
    beforeStep1: true,
    rows: {
      [SAM]: { subscription: { tier: 'premium', provider: 'stripe' } },
      [DANA]: { subscription: { tier: 'free' } },
    },
  });

  const sam = await sync(SAM);
  assert.equal(sam.statusCode, 200);
  assert.equal(sam.body.tier, 'premium', 'not on the list, but Pro stays');

  const dana = await sync(DANA, {}, 'token-dana');
  assert.equal(dana.statusCode, 200);
  assert.equal(dana.body.tier, 'premium');
  assert.deepEqual(supabase.calls.filter((c) => c.name === 'update').map((c) => [c.id, c.patch.subscription.tier]), [[DANA, 'premium']]);

  const report = await call({ action: 'report_content', uid: SAM, targetType: 'dream', targetId: 'd1', reason: 'spam' });
  assert.equal(report.statusCode, 200);
  assert.equal(supabase.profiles[SAM].settings.safetyReports[0].targetId, 'd1', 'reports still land in settings');
});

test("the iPhone app's plan is checked with RevenueCat when the server has its key, and a failure there isn't the app's problem", async (t) => {
  const supabase = withFakes(t, { rows: { [SAM]: { subscription: { tier: 'free', sources: {} } } } });
  process.env.REVENUECAT_SECRET_KEY = 'made-up-secret';
  const asked = [];
  t.mock.method(accountRoute.deps, 'fetch', async (url, options) => {
    asked.push({ url, auth: options.headers.Authorization });
    return {
      ok: true,
      json: async () => ({
        subscriber: { entitlements: { 'Nightlink Pro': { expires_date: '2099-01-01T00:00:00Z', product_identifier: 'nightlink_pro_monthly' } } },
      }),
    };
  });

  const web = await sync(SAM, NEXT_APP);
  assert.equal(asked.length, 0, 'the website with no App Store part asks nobody');
  assert.equal(web.body.tier, 'free');

  const phone = await sync(SAM, { clientSchema: 2, platform: 'ios' });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, `https://api.revenuecat.com/v1/subscribers/${SAM}`);
  assert.equal(phone.body.tier, 'premium');
  const [apple] = named(supabase, 'set_plan_source');
  assert.deepEqual([apple.p_source, apple.p_state.active, apple.p_state.from], ['apple', true, 'revenuecat']);

  t.mock.method(accountRoute.deps, 'fetch', async () => ({ ok: false, status: 503 }));
  const down = await sync(SAM, { clientSchema: 2, platform: 'ios' });
  assert.equal(down.statusCode, 200);
  assert.equal(down.body.tier, 'premium', 'what the database already had');
});

test('nobody can check or report as someone else', async (t) => {
  const supabase = withFakes(t, { rows: { [SAM]: { subscription: { tier: 'free' } }, [DANA]: { subscription: { tier: 'free' } } } });
  assert.equal((await sync(DANA)).statusCode, 401);
  assert.equal((await call({ action: 'report_content', uid: DANA, targetType: 'dream', targetId: 'd1', reason: 'spam' })).statusCode, 401);
  assert.equal((await sync(SAM, {}, 'token-nobody')).statusCode, 401);
  assert.equal(supabase.calls.length, 0);
});

test('a report goes to add_safety_report, where only the server reads it', async (t) => {
  const supabase = withFakes(t, { rows: { [SAM]: { settings: {}, subscription: { tier: 'free' } } } });
  const res = await call({ action: 'report_content', uid: SAM, targetType: 'comment', targetId: 'c9', targetUserId: DANA, reason: 'harassment', details: 'x'.repeat(500) });
  assert.equal(res.statusCode, 200);
  const [report] = named(supabase, 'add_safety_report');
  assert.equal(report.p_user_id, SAM);
  assert.deepEqual([report.p_report.targetType, report.p_report.targetId, report.p_report.targetUserId, report.p_report.reporterId], ['comment', 'c9', DANA, SAM]);
  assert.equal(report.p_report.details.length, 400);
  assert.deepEqual(supabase.profiles[SAM].settings, {}, 'nothing written to settings');
});

test("the AI route's tier uses the comp list the same way", async (t) => {
  withFakes(t, {
    rows: {
      [SAM]: { email: 'dana@example.com', subscription: { tier: 'free' } },
      [DANA]: { email: 'someone@example.com', subscription: { tier: 'free' } },
    },
  });
  const { getUserTier } = aiRoute.internals;
  assert.equal(await getUserTier(USERS['token-sam']), 'free');
  assert.equal(await getUserTier(USERS['token-dana']), 'premium');
});

test('dream memory goes through the server-only functions, and the column before step 1', async (t) => {
  const after = withFakes(t, { rows: { [SAM]: { private_memory: 'Red doors.' } } });
  const { getDreamMemory, saveDreamMemory } = aiRoute.internals;
  assert.equal(await getDreamMemory(SAM), 'Red doors.');
  assert.equal(await saveDreamMemory(SAM, 'Red doors, and stairs.'), null);
  assert.equal(after.profiles[SAM].private_memory, 'Red doors, and stairs.');
  assert.equal(after.calls.filter((c) => c.name === 'update').length, 0, 'no profiles write');

  const before = fakeSupabase({ beforeStep1: true, rows: { [SAM]: { dream_memory: 'Trains.' } } });
  t.mock.method(aiRoute.deps, 'getSupabaseAdmin', () => before.admin);
  assert.equal(await getDreamMemory(SAM), 'Trains.');
  assert.equal(await saveDreamMemory(SAM, 'Trains and tunnels.'), null);
  assert.equal(before.profiles[SAM].dream_memory, 'Trains and tunnels.');
});
