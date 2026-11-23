/**
 * notify: sends a push notification for a single activity event.
 *
 * Called by the client via supabase.functions.invoke('notify', { body: { targetUserId, payload } }).
 * The Supabase JS client automatically attaches the caller's JWT, which we verify here.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendApns, getNotificationCopy } from '../_shared/apns.ts';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY')!;

// How long after its notice a push may still go out, and how many pushes one
// person can send another within the window.
const NOTICE_MAX_AGE_MS = 2 * 60_000;
const PUSH_WINDOW_MS = 10 * 60_000;
const MAX_PUSHES_PER_WINDOW = 20;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  // Verify the caller is an authenticated Supabase user.
  const jwt = (req.headers.get('authorization') ?? '').replace('Bearer ', '');
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { user }, error: authError } = await anonClient.auth.getUser(jwt);
  if (authError || !user) {
    return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
  }

  const { targetUserId, payload } = await req.json() as {
    targetUserId: string;
    payload: Record<string, unknown>;
  };

  if (!targetUserId || !payload?.type) {
    return new Response('Bad request', { status: 400, headers: CORS_HEADERS });
  }

  // Never send a notification to yourself.
  if (targetUserId === user.id) {
    return json({ ok: true, skipped: 'self' });
  }

  // Fetch the target user's tokens and settings using the service role (bypasses RLS).
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile } = await admin
    .from('profiles')
    .select('fcm_tokens, settings')
    .eq('id', targetUserId)
    .single();

  const tokens: string[]               = profile?.fcm_tokens ?? [];
  const settings: Record<string, unknown> = profile?.settings  ?? {};

  if (!tokens.length) return json({ ok: true, skipped: 'no_tokens' });
  if (!settings.notificationsEnabled) return json({ ok: true, skipped: 'notifications_disabled' });

  // Someone this person has blocked can't buzz their phone.
  const blocked = Array.isArray(settings.blockedUserIds) ? settings.blockedUserIds : [];
  if (blocked.includes(user.id)) return json({ ok: true, skipped: 'blocked' });

  // A push only goes out for a notice the caller has just saved for this
  // person: the app always saves the notice first. That keeps a push from
  // saying anything the person's notices don't, and caps how often one person
  // can buzz another's phone.
  const { data: recent } = await admin
    .from('activity')
    .select('type, emoji, dream_title_snapshot, created_at')
    .eq('actor_id', user.id)
    .eq('target_user_id', targetUserId)
    .gte('created_at', new Date(Date.now() - PUSH_WINDOW_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(MAX_PUSHES_PER_WINDOW + 1);
  // The app can set a notice's created_at, so one dated in the future doesn't
  // count: it would otherwise pass for "just saved" forever.
  const noticeAge = (row: { created_at: string }) => Date.now() - new Date(row.created_at).getTime();
  const notice = (recent ?? []).find((row) => row.type === payload.type
    && noticeAge(row) > -60_000
    && noticeAge(row) < NOTICE_MAX_AGE_MS);
  if (!notice) return json({ ok: true, skipped: 'no_notice' });
  if ((recent ?? []).length > MAX_PUSHES_PER_WINDOW) return json({ ok: true, skipped: 'too_many' });

  // Respect per-type opt-outs stored in settings.
  const typeOptOutMap: Record<string, string> = {
    follow:          'notifyActivityAlerts',
    reaction:        'notifyActivityAlerts',
    commentReaction: 'notifyActivityAlerts',
    comment:         'notifyActivityAlerts',
    reply:           'notifyActivityAlerts',
    mention:         'notifyActivityAlerts',
    dreamUpdate:     'notifyActivityAlerts',
  };
  const settingKey = typeOptOutMap[String(payload.type)];
  if (settingKey && settings[settingKey] === false) {
    return json({ ok: true, skipped: 'type_disabled' });
  }

  // Who the push says it's from comes from the caller's own profile. Anyone
  // signed in can call this, and the payload could name anyone ("Sam reacted
  // to your dream" when Sam didn't). The dream title and emoji still come from
  // the app, cut short.
  const { data: sender } = await admin
    .from('profiles')
    .select('display_name, username')
    .eq('id', user.id)
    .single();

  const trusted = {
    ...payload,
    actorId: user.id,
    actorDisplayName: sender?.display_name || sender?.username || 'Someone',
    actorUsername: sender?.username ?? null,
    dreamTitleSnapshot: short(notice.dream_title_snapshot ?? payload.dreamTitleSnapshot, 120),
    emoji: short(notice.emoji ?? payload.emoji, 16),
  };

  const { title, body } = getNotificationCopy(trusted);
  const results = await Promise.all(
    tokens.map(t => sendApns(t, title, body, { activityType: trusted.type, actorId: trusted.actorId }))
  );

  // Remove tokens APNs reported as invalid (BadDeviceToken).
  const badTokens = results.filter(r => r.error === 'BadDeviceToken').map(r => r.token);
  if (badTokens.length) {
    const cleanTokens = tokens.filter(t => !badTokens.includes(t));
    await admin.from('profiles').update({ fcm_tokens: cleanTokens }).eq('id', targetUserId);
  }

  // Only how many went out. The results hold the person's device tokens,
  // which must never go back to whoever sent the notice.
  return json({ ok: true, sent: results.filter((r) => r.ok).length });
});

/** A string from the app cut to `max` characters, counting an emoji as one, or null. */
function short(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || !value) return null;
  return Array.from(value).slice(0, max).join('');
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
