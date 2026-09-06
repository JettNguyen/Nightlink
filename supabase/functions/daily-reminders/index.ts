/**
 * daily-reminders: sends the morning dream-logging reminder to users
 * for whom it is currently 9 AM in their local timezone.
 *
 * Intended to be called once per hour by pg_cron. Secured with the
 * service role key so it can only be triggered internally.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendApns } from '../_shared/apns.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Only callable with the service role key (used by pg_cron).
  const authHeader = (req.headers.get('authorization') ?? '').replace('Bearer ', '');
  if (authHeader !== SERVICE_ROLE_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Fetch all users who have tokens, reminders enabled, and a stored timezone.
  const { data: profiles, error } = await admin
    .from('profiles')
    .select('id, fcm_tokens, settings')
    .not('fcm_tokens', 'eq', '{}');

  if (error) {
    console.error('Failed to fetch profiles:', error.message);
    return json({ ok: false, error: error.message }, 500);
  }

  const now = new Date();
  let sent = 0;
  const badTokenMap: Record<string, string[]> = {};

  for (const profile of profiles ?? []) {
    const settings: Record<string, unknown> = profile.settings ?? {};
    const tokens: string[] = profile.fcm_tokens ?? [];

    if (!tokens.length) continue;
    if (!settings.notificationsEnabled) continue;
    if (!settings.notifyDreamReminders) continue;

    const tz = String(settings.pushTimezone ?? '');
    if (!tz) continue;

    // Check whether it is currently REMINDER_HOUR in the user's timezone.
    let localHour: number;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
      }).formatToParts(now);
      localHour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '-1', 10);
    } catch {
      continue; // Invalid timezone string, so skip.
    }

    const reminderHour = typeof settings.reminderHour === 'number'
      ? Math.max(0, Math.min(23, settings.reminderHour))
      : 9;
    if (localHour !== reminderHour) continue;

    const results = await Promise.all(
      tokens.map(t =>
        sendApns(t, 'Did you have a dream?', 'Log it in Nightlink before it fades.', { type: 'dream-reminder' })
      )
    );

    if (results.some(r => r.ok)) sent++;

    // Collect invalid tokens for cleanup.
    const bad = results.filter(r => r.error === 'BadDeviceToken').map(r => r.token);
    if (bad.length) badTokenMap[profile.id] = bad;
  }

  // Clean up invalid tokens in one batch.
  for (const [userId, badTokens] of Object.entries(badTokenMap)) {
    const { data: p } = await admin.from('profiles').select('fcm_tokens').eq('id', userId).single();
    if (p?.fcm_tokens) {
      const clean = (p.fcm_tokens as string[]).filter((t: string) => !badTokens.includes(t));
      await admin.from('profiles').update({ fcm_tokens: clean }).eq('id', userId);
    }
  }

  console.log(`daily-reminders: sent ${sent} notifications`);
  return json({ ok: true, sent });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
