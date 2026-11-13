const { createClient } = require('@supabase/supabase-js');
const billing = require('./_lib/billing');

const getSupabaseAdmin = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Signs in as the person, with the website's public key, the way the app would.
const getSupabaseAnon = () => {
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!key || !url) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
};

// Tests swap these, so nothing reaches Supabase or RevenueCat.
const deps = { getSupabaseAdmin, getSupabaseAnon, fetch: (...args) => fetch(...args) };

const setCors = (res, origin) => {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
};

const verifyCaller = async (req, expectedUid) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new Error('Authentication required.');

  const admin = deps.getSupabaseAdmin();
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) throw new Error('Invalid session.');
  if (user.id !== expectedUid) throw new Error('You can only delete your own account.');
  return { admin, user };
};

// What the app is told about its own plan. Every app and website page asks on
// start, so this is also where the comp list and the App Store catch up.
//
// A plan has a part per source (api/_lib/billing.js). The comp part follows
// PREMIUM_EMAILS both ways now: taking an email off the list ends that part
// and nothing else, so a paying subscriber is never dropped by it.
//
// An app that doesn't send clientSchema predates plans with sources: Nightlink
// 1.3.2 from the App Store, or a website tab opened before this change. Step 3
// of the profile privacy rollout waits until none has asked for 14 days.
//
// Before step 1 of the rollout is in, the database functions this uses don't
// exist yet; it then does what it always did, which is add Pro for the comp
// list and never take it away.
const syncPlan = async (admin, user, body) => {
  const uid = user.id;

  if (!body?.clientSchema) {
    const { error } = await admin.rpc('note_old_app', { p_user_id: uid });
    if (error && !billing.isMissingFunction(error)) console.error('note_old_app failed:', error.message);
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('subscription')
    .eq('id', uid)
    .single();
  if (profileError) throw profileError;
  let plan = profile?.subscription || {};

  const comped = billing.isComped(user);
  if (comped !== (plan?.sources?.comp?.active === true)) {
    try {
      plan = (await billing.setPlanSource(admin, uid, 'comp', { active: comped, from: 'PREMIUM_EMAILS' })) || plan;
    } catch (error) {
      if (!billing.isMissingFunction(error)) throw error;
      if (comped && plan?.tier !== 'premium') {
        plan = { ...plan, tier: 'premium' };
        const { error: updateError } = await admin.from('profiles').update({ subscription: plan }).eq('id', uid);
        if (updateError) throw updateError;
      }
    }
  }

  // Ask RevenueCat when this is the iPhone app, or the plan has an App Store
  // part, so a purchase shows up without waiting for RevenueCat's webhook.
  // Needs REVENUECAT_SECRET_KEY; without it the webhook alone does this.
  const asksApple = body?.platform === 'ios' || body?.refresh === true || Boolean(plan?.sources?.apple);
  if (asksApple && process.env.REVENUECAT_SECRET_KEY) {
    try {
      plan = (await billing.refreshApplePlan(admin, uid, { fetchImpl: deps.fetch })) || plan;
    } catch (error) {
      console.error('RevenueCat check failed:', error.message);
    }
  }

  return plan;
};

// Signing in with a username instead of an email. Emails aren't something the
// app may read about other people, and from step 3 of the profile privacy
// rollout nobody signed out can read profiles at all, so the server finds the
// email for the username and signs in with it. Every failure gets the same
// answer, so this tells nobody whether a username exists or what its email is.
// The password is never logged.
const SIGN_IN_FAILED = 'We could not sign you in. Check your details and try again.';

const signInWithUsername = async (body) => {
  const username = String(body?.username || '').trim().toLowerCase();
  const password = typeof body?.password === 'string' ? body.password : '';
  const refused = { status: 401, json: { error: SIGN_IN_FAILED, code: 'invalid_credentials' } };
  if (!/^[a-z0-9_]{3,20}$/.test(username) || !password) return refused;

  const anon = deps.getSupabaseAnon();
  if (!anon) {
    console.error('Username sign in refused: SUPABASE_ANON_KEY (or VITE_SUPABASE_ANON_KEY) is not set.');
    return {
      status: 503,
      json: { error: "Signing in with a username isn't working right now. Sign in with your email instead.", code: 'not_set_up' },
    };
  }

  const admin = deps.getSupabaseAdmin();
  const { data: row, error } = await admin.from('profiles').select('id').eq('normalized_username', username).maybeSingle();
  if (error) throw error;
  if (!row?.id) return refused;

  // The email they sign in with, not profiles.email, which apps can write.
  const { data: found, error: userError } = await admin.auth.admin.getUserById(row.id);
  if (userError) throw userError;
  const email = found?.user?.email;
  if (!email) return refused;

  const { data, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  if (signInError || !data?.session) {
    if (/email not confirmed/i.test(signInError?.message || '')) {
      return { status: 403, json: { error: 'Please confirm your email before signing in.', code: 'email_not_confirmed' } };
    }
    return refused;
  }
  return {
    status: 200,
    json: { session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } },
  };
};

// Before step 1 of the rollout: reports go in the reporter's own settings, as
// they always did.
const addReportToSettings = async (admin, uid, report) => {
  const { data: reporter, error: reporterError } = await admin
    .from('profiles')
    .select('settings')
    .eq('id', uid)
    .single();
  if (reporterError) throw reporterError;

  const currentSettings = reporter?.settings || {};
  const currentReports = Array.isArray(currentSettings.safetyReports) ? currentSettings.safetyReports : [];
  const { error: updateError } = await admin
    .from('profiles')
    .update({ settings: { ...currentSettings, safetyReports: [report, ...currentReports].slice(0, 100) } })
    .eq('id', uid);
  if (updateError) throw updateError;
};

module.exports = async function handler(req, res) {
  setCors(res, req.headers?.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  const { action, uid, confirmText } = body || {};
  if (!action) return res.status(400).json({ error: 'Missing action' });

  if (action === 'sign_in_with_username') {
    try {
      const { status, json } = await signInWithUsername(body);
      return res.status(status).json(json);
    } catch (error) {
      console.error('sign_in_with_username failed:', error?.message || error);
      return res.status(500).json({ error: 'Signing in failed. Try again in a minute.', code: 'try_again' });
    }
  }

  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  let admin;
  let user;
  try {
    ({ admin, user } = await verifyCaller(req, uid));
  } catch (error) {
    return res.status(401).json({ error: error.message || 'Unauthorized.' });
  }

  if (action === 'sync_subscription_tier') {
    try {
      const plan = await syncPlan(admin, user, body);
      return res.status(200).json({
        success: true,
        tier: plan?.tier === 'premium' ? 'premium' : 'free',
        subscription: plan
      });
    } catch (error) {
      console.error('sync_subscription_tier failed', error);
      return res.status(500).json({ error: 'Failed to sync subscription tier.' });
    }
  }

  if (action === 'report_content') {
    const { targetType, targetId, targetUserId, reason, details } = body || {};
    if (!targetType || !targetId || !reason) {
      return res.status(400).json({ error: 'Missing report details.' });
    }

    try {
      const now = new Date().toISOString();
      const reportRecord = {
        id: `${now}:${targetType}:${targetId}`,
        createdAt: now,
        reporterId: uid,
        targetType,
        targetId,
        targetUserId: targetUserId || null,
        reason: String(reason).slice(0, 160),
        details: String(details || '').slice(0, 400),
        status: 'submitted'
      };

      // Kept where only the server reads them once step 2 of the rollout is
      // in; anyone signed in could read the reporter's settings before.
      const { error: reportError } = await admin.rpc('add_safety_report', { p_user_id: uid, p_report: reportRecord });
      if (reportError) {
        if (!billing.isMissingFunction(reportError)) throw reportError;
        await addReportToSettings(admin, uid, reportRecord);
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('report_content failed', error);
      return res.status(500).json({ error: error.message || 'Could not submit report.' });
    }
  }

  // Handle delete_account action
  if (action !== 'delete_account') return res.status(400).json({ error: 'Unknown action' });
  if (confirmText !== 'DELETE') return res.status(400).json({ error: 'Invalid confirmation phrase.' });

  try {
    const { data: dreamRows, error: dreamError } = await admin
      .from('dreams')
      .select('id')
      .eq('user_id', uid);
    if (dreamError) throw dreamError;

    const { data: commentRows, error: commentError } = await admin
      .from('comments')
      .select('id')
      .eq('user_id', uid);
    if (commentError) throw commentError;

    const dreamIds = (dreamRows || []).map((row) => row.id).filter(Boolean);
    const commentIds = (commentRows || []).map((row) => row.id).filter(Boolean);

    if (commentIds.length) {
      const { error: detachReplyError } = await admin
        .from('comments')
        .update({ parent_comment_id: null, parent_comment_user_id: null })
        .in('parent_comment_id', commentIds);
      if (detachReplyError) throw detachReplyError;
    }

    const { error: detachParentUserError } = await admin
      .from('comments')
      .update({ parent_comment_user_id: null })
      .eq('parent_comment_user_id', uid);
    if (detachParentUserError) throw detachParentUserError;

    if (dreamIds.length) {
      const { error: deleteDreamActivityError } = await admin
        .from('activity')
        .delete()
        .in('dream_id', dreamIds);
      if (deleteDreamActivityError) throw deleteDreamActivityError;
    }

    if (commentIds.length) {
      const { error: deleteCommentActivityError } = await admin
        .from('activity')
        .delete()
        .in('comment_id', commentIds);
      if (deleteCommentActivityError) throw deleteCommentActivityError;
    }

    const { error: deleteOwnedActivityError } = await admin
      .from('activity')
      .delete()
      .or(`target_user_id.eq.${uid},actor_id.eq.${uid},dream_owner_id.eq.${uid}`);
    if (deleteOwnedActivityError) throw deleteOwnedActivityError;

    const { error: deleteCommentsError } = await admin
      .from('comments')
      .delete()
      .eq('user_id', uid);
    if (deleteCommentsError) throw deleteCommentsError;

    const { error: deleteDreamsError } = await admin
      .from('dreams')
      .delete()
      .eq('user_id', uid);
    if (deleteDreamsError) throw deleteDreamsError;

    const { error: deleteProfileError } = await admin
      .from('profiles')
      .delete()
      .eq('id', uid);
    if (deleteProfileError) throw deleteProfileError;

    const { error: deleteAuthError } = await admin.auth.admin.deleteUser(uid);
    if (deleteAuthError) throw deleteAuthError;

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('delete_account failed', error);
    return res.status(500).json({ error: error.message || 'Failed to delete account.' });
  }
};

module.exports.deps = deps;
