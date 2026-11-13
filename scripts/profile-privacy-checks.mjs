#!/usr/bin/env node
// Tests the profile privacy rollout (supabase/rollout) on a throwaway Postgres
// made for the run and deleted after it. Never touches the live database.
//
//   npm run test:db
//
// Needs initdb, pg_ctl and psql on PATH (Homebrew's postgresql@16 or newer).
//
// It loads supabase/schema.sql on top of the parts of Supabase it leans on
// (supabase/tests/supabase-stubs.sql) and three made-up people
// (supabase/tests/seed.sql), then runs every check below as each phase lands:
// before any step, after step 1, step 2 and step 3. A check runs as anon (signed
// out), as Sam, Dana or Ellen (signed in, with PostgREST's request.jwt.claims
// set the way it sets them), or as the server's service key, and is rolled back
// after, so checks never see each other's writes.
//
// Every check says, for every phase, whether it should hold. The run fails if
// any check does something else, so the table shows the holes open before the
// rollout and closed after it, and 1.3.2's queries working until step 3.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const file = (path) => join(ROOT, path);

const PEOPLE = {
  sam: '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61',
  dana: 'f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42',
  ellen: '0c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6',
  mike: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
};
const { sam: SAM, dana: DANA, ellen: ELLEN, mike: MIKE } = PEOPLE;

const PHASES = ['before', 'step 1', 'step 2', 'step 3'];
const all = (value) => Object.fromEntries(PHASES.map((p) => [p, value]));
const from = (first) => Object.fromEntries(PHASES.map((p) => [p, PHASES.indexOf(p) >= PHASES.indexOf(first)]));
const until = (last) => Object.fromEntries(PHASES.map((p) => [p, PHASES.indexOf(p) <= PHASES.indexOf(last)]));

const PUBLIC_COLUMNS = 'id, display_name, username, normalized_username, photo_url, avatar_icon, '
  + 'avatar_background, avatar_color, account_visibility, following_ids, follower_ids, bio, tier';

// ── The checks ───────────────────────────────────────────────────────────────
// sql:   what runs as `who`. Its rows come back as `rows`.
// after: optional, runs as postgres once `sql` is done. Its rows come back as `after`.
// ok:    given { rows, after, error }, whether the check holds.
// holds: per phase, whether it should hold.

const denied = ({ error }) => /permission denied/.test(error || '');
const value = ({ rows }) => rows?.[0] && Object.values(rows[0])[0];
const hidden = (result) => denied(result) || (!result.error && (result.rows || []).every((row) => Object.values(row).every((v) => v === null || (Array.isArray(v) && !v.length))));
const works = ({ error }) => !error;

const checks = [
  // Signed out, with only the website's public key.
  {
    group: 'Signed out',
    name: 'can read every column of every profile (select *)',
    who: 'anon',
    sql: 'select * from public.profiles',
    ok: denied,
    holds: from('step 1'),
  },
  {
    group: 'Signed out',
    name: "can read Sam's dream memory",
    who: 'anon',
    sql: `select p.dream_memory from public.profiles p where p.id = '${SAM}'`,
    ok: hidden,
    holds: from('step 1'),
  },
  {
    group: 'Signed out',
    name: "can read Sam's settings, plan, credits and push tokens",
    who: 'anon',
    sql: `select settings, subscription, ai_usage, fcm_tokens from public.profiles where id = '${SAM}'`,
    ok: denied,
    holds: from('step 1'),
  },
  {
    group: 'Signed out',
    name: 'can read every email with its username (1.3.2 signs in this way)',
    who: 'anon',
    sql: 'select normalized_username, email from public.profiles',
    ok: denied,
    holds: from('step 3'),
  },

  // Signed in as Ellen, looking at other people.
  {
    group: 'Ellen, about Sam',
    name: "can read Sam's whole row (select *)",
    who: 'ellen',
    sql: `select * from public.profiles where id = '${SAM}'`,
    ok: denied,
    holds: from('step 3'),
  },
  {
    group: 'Ellen, about Sam',
    name: "can read Sam's dream memory",
    who: 'ellen',
    sql: `select p.dream_memory, p.dream_memory_updated_at from public.profiles p where p.id = '${SAM}'`,
    ok: hidden,
    holds: from('step 2'),
  },
  {
    group: 'Ellen, about Sam',
    name: 'can read who Dana reported',
    who: 'ellen',
    sql: `select settings -> 'safetyReports' as reports from public.profiles where id = '${DANA}'`,
    ok: hidden,
    holds: from('step 2'),
  },
  {
    group: 'Ellen, about Sam',
    name: "can read Dana's premium_emails",
    who: 'ellen',
    sql: `select premium_emails from public.profiles where id = '${DANA}'`,
    ok: hidden,
    holds: from('step 2'),
  },
  {
    group: 'Ellen, about Sam',
    name: "can read Sam's email",
    who: 'ellen',
    sql: `select email from public.profiles where id = '${SAM}'`,
    ok: denied,
    holds: from('step 3'),
  },
  {
    group: 'Ellen, about Sam',
    name: "can read Sam's settings (blocks, custom prompt)",
    who: 'ellen',
    sql: `select settings from public.profiles where id = '${SAM}'`,
    ok: denied,
    holds: from('step 3'),
  },
  {
    group: 'Ellen, about Sam',
    name: "can read Sam's plan details, credits and push tokens",
    who: 'ellen',
    sql: `select subscription, ai_usage, fcm_tokens from public.profiles where id = '${SAM}'`,
    ok: denied,
    holds: from('step 3'),
  },
  {
    group: 'Ellen, about Sam',
    name: 'can read the server-only tables',
    who: 'ellen',
    sql: 'select (select count(*) from public.profile_private) + (select count(*) from public.billing_events) as n',
    // Before step 1 they don't exist, which keeps them out too.
    ok: (r) => denied(r) || /does not exist/.test(r.error || ''),
    holds: all(true),
  },
  {
    group: 'Ellen, about Sam',
    name: "can spend Sam's AI usage through check_and_increment_ai_quota",
    who: 'ellen',
    sql: `select public.check_and_increment_ai_quota('${SAM}', '2026-11') as answer`,
    ok: denied,
    holds: from('step 1'),
  },

  // Apps writing their own row.
  {
    group: 'Apps writing their own row',
    name: 'Ellen gives herself Pro',
    who: 'ellen',
    sql: `update public.profiles set subscription = '{"tier": "premium"}' where id = '${ELLEN}'`,
    after: `select subscription ->> 'tier' as tier from public.profiles where id = '${ELLEN}'`,
    ok: ({ after }) => after?.[0]?.tier === 'free',
    holds: from('step 2'),
  },
  {
    group: 'Apps writing their own row',
    name: 'Ellen gives herself 999 credits',
    who: 'ellen',
    sql: `update public.profiles set ai_usage = ai_usage || '{"creditBalance": 999}' where id = '${ELLEN}'`,
    after: `select ai_usage -> 'creditBalance' as credits from public.profiles where id = '${ELLEN}'`,
    // In step 3 the write can't even read ai_usage to add to it.
    ok: ({ error, after }) => Boolean(error) || Number(after?.[0]?.credits) === 0,
    holds: from('step 2'),
  },
  {
    group: 'Apps writing their own row',
    name: 'Sam starts his month over (usage back to 0)',
    who: 'sam',
    sql: `update public.profiles set ai_usage = '{"monthYear": "2026-11", "monthlyCount": 0, "creditBalance": 5}' where id = '${SAM}'`,
    after: `select ai_usage ->> 'monthlyCount' as used from public.profiles where id = '${SAM}'`,
    ok: ({ after }) => after?.[0]?.used === '3',
    holds: from('step 2'),
  },
  {
    group: 'Apps writing their own row',
    name: "Ellen changes Sam's row",
    who: 'ellen',
    sql: `update public.profiles set display_name = 'Not Sam', ai_usage = '{"monthlyCount": 0}' where id = '${SAM}'`,
    after: `select display_name, ai_usage ->> 'monthlyCount' as used from public.profiles where id = '${SAM}'`,
    ok: ({ after }) => after?.[0]?.display_name === 'Sam' && after?.[0]?.used === '3',
    holds: all(true),
  },
  {
    group: 'Apps writing their own row',
    name: 'a new account starts on Pro with credits',
    who: 'mike',
    sql: `insert into public.profiles (id, email, display_name, username, normalized_username, subscription, ai_usage, premium_emails)
          values ('${MIKE}', 'mike@example.com', 'Mike', 'mike', 'mike', '{"tier": "premium"}', '{"creditBalance": 500}', '{mike@example.com}')`,
    after: `select subscription ->> 'tier' as tier, ai_usage -> 'creditBalance' as credits, premium_emails from public.profiles where id = '${MIKE}'`,
    ok: ({ after }) => after?.[0]?.tier === 'free' && Number(after?.[0]?.credits) === 0 && !after?.[0]?.premium_emails?.length,
    holds: from('step 1'),
  },
  {
    group: 'Apps writing their own row',
    name: "1.3.2's App Store sync drops a website subscriber to Free",
    who: 'sam',
    // Sam pays on the website. Before the rollout the webhook just set tier.
    setup: `do $$ begin
              if to_regprocedure('public.set_plan_source(uuid,text,jsonb)') is null then
                update public.profiles set subscription = '{"tier": "premium"}' where id = '${SAM}';
              else
                execute format('select public.set_plan_source(%L, %L, %L::jsonb)', '${SAM}', 'web', '{"active": true}');
              end if;
            end $$;`,
    sql: `update public.profiles set subscription = '{"tier": "free", "provider": "revenuecat", "expiresAt": null}' where id = '${SAM}'`,
    after: `select subscription ->> 'tier' as tier from public.profiles where id = '${SAM}'`,
    ok: ({ after }) => after?.[0]?.tier === 'premium',
    holds: from('step 1'),
  },

  // What Nightlink 1.3.2 (bc21746) runs. These must keep working until step 3.
  {
    group: '1.3.2 keeps working',
    name: 'sign in with a username (email by username, signed out)',
    who: 'anon',
    sql: "select email from public.profiles where normalized_username = 'dana'",
    ok: (r) => value(r) === 'dana@example.com',
    holds: until('step 2'),
  },
  {
    group: '1.3.2 keeps working',
    name: 'sign up checks the username (signed out)',
    who: 'anon',
    sql: "select id from public.profiles where normalized_username = 'newname'",
    ok: (r) => works(r) && !r.rows.length,
    holds: until('step 2'),
  },
  {
    group: '1.3.2 keeps working',
    name: 'own row with select * (Settings, EditProfile)',
    who: 'sam',
    sql: `select * from public.profiles where id = '${SAM}'`,
    ok: (r) => works(r) && r.rows[0]?.email === 'sam@example.com' && r.rows[0]?.settings?.blockedUserIds?.length === 1,
    holds: until('step 2'),
  },
  {
    group: '1.3.2 keeps working',
    name: 'Dream Insights (subscription, dream_memory, dream_memory_updated_at)',
    who: 'sam',
    sql: `select p.subscription, p.dream_memory, p.dream_memory_updated_at from public.profiles p where p.id = '${SAM}'`,
    ok: (r) => works(r) && r.rows[0]?.dream_memory === 'Sam keeps dreaming about a red door.' && r.rows[0]?.subscription?.tier === 'premium',
    holds: until('step 2'),
  },
  {
    group: '1.3.2 keeps working',
    name: "someone else's profile page (select *)",
    who: 'ellen',
    sql: `select * from public.profiles where id = '${SAM}'`,
    ok: (r) => works(r) && r.rows[0]?.username === 'Sam' && r.rows[0]?.settings?.bio === 'Lucid most nights.'
      && r.rows[0]?.subscription?.tier === 'premium' && r.rows[0]?.follower_ids?.length === 1,
    holds: until('step 2'),
  },
  {
    group: '1.3.2 keeps working',
    name: 'feed authors (select * where id in following)',
    who: 'ellen',
    sql: `select * from public.profiles where id in ('${SAM}', '${DANA}')`,
    ok: (r) => works(r) && r.rows.length === 2,
    holds: until('step 2'),
  },
  {
    group: '1.3.2 keeps working',
    name: 'search people (with subscription for the Pro badge)',
    who: 'ellen',
    sql: `select id, display_name, username, photo_url, avatar_icon, avatar_background, avatar_color, subscription
          from public.profiles where (display_name ilike '%a%' or username ilike '%a%') and id <> '${ELLEN}' limit 15`,
    ok: (r) => works(r) && r.rows.length === 2,
    holds: until('step 2'),
  },
  {
    group: '1.3.2 keeps working',
    name: 'activity feed embeds the owner (profiles!user_id(following_ids, follower_ids))',
    who: 'ellen',
    sql: `select d.id, (select row_to_json(x) from (select p.following_ids, p.follower_ids from public.profiles p where p.id = d.user_id) x) as profiles
          from public.dreams d where d.user_id in ('${SAM}') and d.visibility in ('public', 'followers', 'mutuals')`,
    ok: (r) => works(r) && r.rows.length === 2 && r.rows.every((row) => row.profiles?.follower_ids?.length === 1),
    holds: all(true),
  },
  {
    group: '1.3.2 keeps working',
    name: "followers-only dream visible to a follower (dreams policy reads profiles)",
    who: 'ellen',
    sql: "select id from public.dreams where id = '11111111-1111-4111-8111-111111111111'",
    ok: (r) => works(r) && r.rows.length === 1,
    holds: all(true),
  },
  {
    group: '1.3.2 keeps working',
    name: 'mention and tag lookups by handle',
    who: 'ellen',
    sql: "select id, username, display_name from public.profiles where normalized_username in ('sam', 'dana')",
    ok: (r) => works(r) && r.rows.length === 2,
    holds: all(true),
  },
  {
    group: '1.3.2 keeps working',
    name: 'sign up inserts the profile',
    who: 'mike',
    sql: `insert into public.profiles (id, email, display_name, username, normalized_username, is_anonymous, following_ids, follower_ids)
          values ('${MIKE}', 'mike@example.com', 'Mike', 'mike', 'mike', false, '{}', '{}')`,
    after: `select username, email from public.profiles where id = '${MIKE}'`,
    ok: ({ error, after }) => !error && after?.[0]?.username === 'mike',
    holds: all(true),
  },
  {
    group: '1.3.2 keeps working',
    name: 'Edit profile saves name, avatar, visibility and bio',
    who: 'sam',
    // PostgREST sets each column to the value the app sent, without reading it.
    sql: `update public.profiles set display_name = 'Sammy', avatar_icon = 'moon', account_visibility = 'private',
            settings = '{"bio": "New bio.", "accountVisibility": "private", "termsVersion": "v3"}' where id = '${SAM}'`,
    after: `select display_name, settings ->> 'bio' as bio from public.profiles where id = '${SAM}'`,
    ok: ({ error, after }) => !error && after?.[0]?.display_name === 'Sammy' && after?.[0]?.bio === 'New bio.',
    holds: all(true),
  },
  {
    group: '1.3.2 keeps working',
    name: 'push token, feed seen time and photo are saved',
    who: 'sam',
    sql: `update public.profiles set fcm_tokens = '{apns-token-sam, apns-token-new}', feed_seen_at_ms = 1794583518000,
            photo_url = 'https://example.com/a.jpg' where id = '${SAM}'`,
    after: `select array_length(fcm_tokens, 1) as tokens, feed_seen_at_ms, photo_url from public.profiles where id = '${SAM}'`,
    ok: ({ error, after }) => !error && after?.[0]?.tokens === 2 && after?.[0]?.photo_url,
    holds: all(true),
  },
  {
    group: '1.3.2 keeps working',
    name: "App Store sync and a credit pack write don't error",
    who: 'sam',
    sql: `update public.profiles set subscription = '{"tier": "premium", "provider": "revenuecat", "expiresAt": "2099-01-01T00:00:00Z"}' where id = '${SAM}';
          update public.profiles set ai_usage = '{"monthYear": "2026-11", "monthlyCount": 3, "creditBalance": 15}' where id = '${SAM}'`,
    ok: works,
    holds: all(true),
  },
  {
    group: '1.3.2 keeps working',
    name: 'follow someone public (request_follow)',
    who: 'dana',
    sql: `select public.request_follow('${SAM}') as answer`,
    after: `select '${DANA}' = any(follower_ids) as following from public.profiles where id = '${SAM}'`,
    ok: ({ error, after }) => !error && after?.[0]?.following === true,
    holds: all(true),
  },

  // What the next app version runs.
  {
    group: 'The next version works',
    name: 'own row through my_profile()',
    who: 'sam',
    sql: 'select email, settings, subscription, ai_usage, fcm_tokens from public.my_profile()',
    ok: (r) => works(r) && r.rows.length === 1 && r.rows[0].email === 'sam@example.com' && r.rows[0].settings?.aiPromptCustom === 'Be gentle.',
    holds: from('step 1'),
  },
  {
    group: 'The next version works',
    name: 'my_profile() gives nothing to someone signed out',
    who: 'anon',
    sql: 'select * from public.my_profile()',
    ok: (r) => denied(r) || (works(r) && !r.rows.length),
    holds: from('step 1'),
  },
  {
    group: 'The next version works',
    name: 'own dream memory through my_dream_memory()',
    who: 'sam',
    sql: 'select * from public.my_dream_memory()',
    ok: (r) => works(r) && r.rows[0]?.dream_memory === 'Sam keeps dreaming about a red door.',
    holds: from('step 1'),
  },
  {
    group: 'The next version works',
    name: "someone else's profile, public columns only",
    who: 'ellen',
    sql: `select ${PUBLIC_COLUMNS} from public.profiles where id = '${SAM}'`,
    ok: (r) => works(r) && r.rows[0]?.bio === 'Lucid most nights.' && r.rows[0]?.tier === 'premium',
    holds: from('step 1'),
  },
  {
    group: 'The next version works',
    name: 'search people with tier for the Pro badge',
    who: 'ellen',
    sql: `select id, display_name, username, photo_url, avatar_icon, avatar_background, avatar_color, tier
          from public.profiles where (display_name ilike '%a%' or username ilike '%a%') and id <> '${ELLEN}' limit 15`,
    ok: (r) => works(r) && r.rows.length === 2,
    holds: from('step 1'),
  },
  {
    group: 'The next version works',
    name: 'username_taken() for sign up, signed out',
    who: 'anon',
    sql: "select public.username_taken('SAM') as taken, public.username_taken('nobody') as free",
    ok: (r) => works(r) && r.rows[0].taken === true && r.rows[0].free === false,
    holds: from('step 1'),
  },

  // The server, with the service key.
  {
    group: 'The server',
    name: 'turns on a website plan for Ellen',
    who: 'service',
    sql: `select public.set_plan_source('${ELLEN}', 'web', '{"active": true, "eventAt": 1794583518000}') ->> 'tier' as tier`,
    ok: (r) => value(r) === 'premium',
    holds: from('step 1'),
  },
  {
    group: 'The server',
    name: 'ignores a Stripe event older than the one it applied',
    who: 'service',
    sql: `select public.set_plan_source('${ELLEN}', 'web', '{"active": true, "eventAt": 2000}');
          select public.set_plan_source('${ELLEN}', 'web', '{"active": false, "eventAt": 1000}') ->> 'tier' as tier`,
    ok: (r) => value(r) === 'premium',
    holds: from('step 1'),
  },
  {
    group: 'The server',
    name: "an App Store expiry doesn't end a website plan",
    who: 'service',
    sql: `select public.set_plan_source('${SAM}', 'web', '{"active": true}');
          select public.set_plan_source('${SAM}', 'apple', '{"active": false}') ->> 'tier' as tier`,
    ok: (r) => value(r) === 'premium',
    holds: from('step 1'),
  },
  {
    group: 'The server',
    name: "an App Store expiry leaves Dana's old Pro alone",
    who: 'service',
    sql: `select public.set_plan_source('${DANA}', 'apple', '{"active": false, "from": "revenuecat"}') ->> 'tier' as tier`,
    ok: (r) => value(r) === 'premium',
    holds: from('step 1'),
  },
  {
    group: 'The server',
    name: "a website plan takes over Dana's old Pro and ends it when she cancels",
    who: 'service',
    sql: `select public.set_plan_source('${DANA}', 'web', '{"active": true, "eventAt": 1000}');
          select public.set_plan_source('${DANA}', 'web', '{"active": false, "eventAt": 2000}') ->> 'tier' as tier`,
    ok: (r) => value(r) === 'free',
    holds: from('step 1'),
  },
  {
    group: 'The server',
    name: 'adds a website credit pack once, however often Stripe sends it',
    who: 'service',
    sql: `select public.grant_ai_credits('${ELLEN}', 10, 'stripe:cs_1', 'stripe');
          select public.grant_ai_credits('${ELLEN}', 10, 'stripe:cs_1', 'stripe') ->> 'reason' as second`,
    after: `select ai_usage -> 'creditBalance' as credits from public.profiles where id = '${ELLEN}'`,
    ok: ({ rows, after }) => rows?.[0]?.second === 'already_granted' && Number(after?.[0]?.credits) === 10,
    holds: from('step 1'),
  },
  {
    group: 'The server',
    name: 'adds an App Store credit pack only once apps stop adding their own',
    who: 'service',
    sql: `select public.grant_ai_credits('${ELLEN}', 10, 'revenuecat:tx_1', 'revenuecat', now() + interval '1 minute') ->> 'granted' as granted`,
    ok: (r) => value(r) === 'true',
    holds: from('step 2'),
  },
  {
    group: 'The server',
    name: 'reads and saves dream memory',
    who: 'service',
    sql: `select public.save_dream_memory('${ELLEN}', 'Ellen dreams of trains.');
          select public.get_dream_memory('${ELLEN}') as memory`,
    ok: (r) => value(r) === 'Ellen dreams of trains.',
    holds: from('step 1'),
  },
  {
    group: 'The server',
    name: 'files a safety report where only it can read it',
    who: 'service',
    sql: `select public.add_safety_report('${ELLEN}', '{"targetId": "z", "reason": "spam"}')`,
    after: `select coalesce(
              (select safety_reports from public.profile_private where id = '${ELLEN}'),
              (select settings -> 'safetyReports' from public.profiles where id = '${ELLEN}')) -> 0 ->> 'reason' as reason`,
    ok: ({ error, after }) => !error && after?.[0]?.reason === 'spam',
    holds: from('step 1'),
  },
];

// ── Running them ─────────────────────────────────────────────────────────────

const need = (bin) => {
  const found = spawnSync('which', [bin], { encoding: 'utf8' });
  if (found.status !== 0) {
    console.error(`${bin} isn't on PATH. Install Postgres (brew install postgresql@16) and try again.`);
    process.exit(1);
  }
};
['initdb', 'pg_ctl', 'psql'].forEach(need);

const dataDir = mkdtempSync(join(tmpdir(), 'nightlink-pg-'));
// Postgres refuses socket paths over 103 bytes, and macOS's temp dir is long.
const socketDir = mkdtempSync('/tmp/nlpg-');
const port = String(56000 + Math.floor(Math.random() * 2000));
let started = false;

const cleanUp = () => {
  if (started) spawnSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
};
process.on('exit', cleanUp);

const psql = (sql, { db = 'nightlink', stopOnError = true } = {}) => spawnSync('psql', [
  '-h', socketDir, '-p', port, '-U', 'postgres', '-d', db, '-X', '-q', '-t', '-A',
  '-v', `ON_ERROR_STOP=${stopOnError ? 1 : 0}`,
], { input: sql, encoding: 'utf8' });

const runFile = (path, label) => {
  const out = psql(readFileSync(file(path), 'utf8'));
  if (out.status !== 0) throw new Error(`${label} failed:\n${out.stderr}`);
};

execFileSync('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], { stdio: 'ignore' });
execFileSync('pg_ctl', ['-D', dataDir, '-w', '-l', join(dataDir, 'log.txt'), '-o', `-p ${port} -k ${socketDir} -c listen_addresses=''`, 'start'], { stdio: 'ignore' });
started = true;
psql('create database nightlink;', { db: 'postgres' });

runFile('supabase/tests/supabase-stubs.sql', 'The Supabase stubs');
// schema.sql reads comments before it creates them, which only works on a
// database that already has them, so a fresh one takes it twice.
psql(readFileSync(file('supabase/schema.sql'), 'utf8'), { stopOnError: false });
runFile('supabase/schema.sql', 'schema.sql');
runFile('supabase/tests/seed.sql', 'The seed');

const claimsFor = (who) => {
  if (who === 'anon') return { role: 'anon', claims: { role: 'anon' } };
  if (who === 'service') return { role: 'service_role', claims: { role: 'service_role' } };
  return { role: 'authenticated', claims: { sub: PEOPLE[who], role: 'authenticated' } };
};

const RESULT = '@@result@@';
const AFTER = '@@after@@';

const runCheck = (check) => {
  const { role, claims } = claimsFor(check.who);
  const statements = check.sql.trim().split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  const last = statements.pop();
  const isQuery = /^select\b/i.test(last);
  const script = [
    'begin;',
    check.setup || '',
    `do $$ begin perform set_config('request.jwt.claims', '${JSON.stringify(claims)}', true); end $$;`,
    `set local role ${role};`,
    ...statements.map((s) => `${s};`),
    isQuery ? `select '${RESULT}' || coalesce(jsonb_agg(to_jsonb(t))::text, '[]') from (${last}) t;` : `${last};`,
    'reset role;',
    check.after ? `select '${AFTER}' || coalesce(jsonb_agg(to_jsonb(t))::text, '[]') from (${check.after}) t;` : '',
    'rollback;',
  ].join('\n');
  const out = psql(script);
  const lines = out.stdout.split('\n');
  // jsonb prints on one line, so each marker is one line of output.
  const pick = (marker) => {
    const line = lines.find((l) => l.startsWith(marker));
    try { return line ? JSON.parse(line.slice(marker.length)) : undefined; } catch { return undefined; }
  };
  const error = out.status === 0 ? null : (out.stderr.match(/ERROR:\s+(.*)/) || [])[1] || out.stderr.trim();
  return { rows: pick(RESULT) || [], after: pick(AFTER), error };
};

const results = new Map(checks.map((c) => [c, {}]));
const runAll = (phase) => {
  for (const check of checks) {
    const result = runCheck(check);
    let held;
    try { held = Boolean(check.ok(result)); } catch { held = false; }
    results.get(check)[phase] = { held, result };
  }
};

let failed = false;
try {
  runAll('before');
  runFile('supabase/rollout/1-profile-privacy-add.sql', 'Step 1');
  runFile('supabase/rollout/1-profile-privacy-add.sql', 'Step 1, run a second time');
  runAll('step 1');

  // Step 2 waits for RevenueCat to reach the server.
  const early = psql(readFileSync(file('supabase/rollout/2-profile-privacy-lock.sql'), 'utf8'));
  if (early.status === 0 || !/RevenueCat hasn't reached the server/.test(early.stderr)) {
    throw new Error('Step 2 ran before RevenueCat had sent anything.');
  }
  psql("select public.record_billing_event('revenuecat:test', 'revenuecat', 'TEST', null);");
  runFile('supabase/rollout/2-profile-privacy-lock.sql', 'Step 2');
  runAll('step 2');

  // Step 3 waits until nobody has used 1.3.2 for 14 days.
  psql(`select public.note_old_app('${SAM}');`);
  const tooSoon = psql(readFileSync(file('supabase/rollout/3-profile-privacy-close.sql'), 'utf8'));
  if (tooSoon.status === 0 || !/opened Nightlink 1\.3\.2/.test(tooSoon.stderr)) {
    throw new Error('Step 3 ran while an old app had been seen this week.');
  }
  psql("update public.profile_private set old_app_seen_at = now() - interval '15 days';");
  runFile('supabase/rollout/3-profile-privacy-close.sql', 'Step 3');
  runAll('step 3');
} catch (err) {
  console.error(err.message);
  failed = true;
}

// ── The table ────────────────────────────────────────────────────────────────

const pad = (text, width) => (text.length >= width ? text : text + ' '.repeat(width - text.length));
const cell = (entry, expected) => {
  if (!entry) return pad('not run', 9);
  if (entry.held === expected) return pad(entry.held ? 'yes' : 'no', 9);
  return pad(entry.held ? 'YES (!!)' : 'NO (!!)', 9);
};

console.log('\nEach row is a statement. "yes" means it is true in that phase, "no" that it is not.');
console.log('A cell marked (!!) is the opposite of what the rollout promises.\n');
let group = '';
for (const check of checks) {
  if (check.group !== group) {
    group = check.group;
    console.log(`\n${group}${' '.repeat(Math.max(1, 76 - group.length))}${PHASES.map((p) => pad(p, 9)).join(' ')}`);
  }
  const attack = !/keeps working|next version works|The server/.test(check.group);
  const row = PHASES.map((phase) => {
    // For holes, "holds" means closed, so the statement "can read X" is true when it doesn't hold.
    const entry = results.get(check)[phase];
    const expected = check.holds[phase];
    const statementTrue = entry ? (attack ? !entry.held : entry.held) : undefined;
    const statementExpected = attack ? !expected : expected;
    if (entry && entry.held !== expected) failed = true;
    return cell(entry && { held: statementTrue }, statementExpected);
  });
  console.log(`  ${pad(check.name, 74)}${row.join(' ')}`);
}

const mismatches = checks.flatMap((check) => PHASES
  .filter((phase) => results.get(check)[phase] && results.get(check)[phase].held !== check.holds[phase])
  .map((phase) => `${check.group} / ${check.name} / ${phase}: ${JSON.stringify(results.get(check)[phase].result).slice(0, 400)}`));
if (mismatches.length) console.log(`\nUnexpected:\n  ${mismatches.join('\n  ')}`);

console.log(failed ? '\nFAILED' : `\nAll ${checks.length} checks behaved as promised in all four phases.`);
process.exitCode = failed ? 1 : 0;
