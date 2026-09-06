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

  const { title, body } = getNotificationCopy(payload);
  const results = await Promise.all(
    tokens.map(t => sendApns(t, title, body, { activityType: payload.type, actorId: payload.actorId }))
  );

  // Remove tokens APNs reported as invalid (BadDeviceToken).
  const badTokens = results.filter(r => r.error === 'BadDeviceToken').map(r => r.token);
  if (badTokens.length) {
    const cleanTokens = tokens.filter(t => !badTokens.includes(t));
    await admin.from('profiles').update({ fcm_tokens: cleanTokens }).eq('id', targetUserId);
  }

  return json({ ok: true, results });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
