-- ============================================================================
-- Profile privacy, step 1 of 3: add
-- ============================================================================
--
-- Run in Supabase's SQL editor, once, before pushing the code that uses it.
-- Safe for Nightlink 1.3.2 from the App Store (bc21746), the website as it is
-- now, and the server as it is now. Running it twice changes nothing more.
-- These files are kept out of supabase/migrations on purpose, so no `supabase
-- db push` can run all three at once: step 3 would break 1.3.2.
--
-- What it does
--
-- 1. Signed-out visitors can read only what signing in with a username and
--    the dreams policy need: id, normalized_username, email, follower_ids and
--    following_ids. Dream memory, settings, plans, credits and push tokens
--    were open to anyone holding the website's public key; now they aren't.
--    1.3.2 looks up the email for a username before signing in, so that stays
--    until step 3.
--
-- 2. Plans remember where they came from. subscription.sources has a part per
--    source: apple (the App Store, through RevenueCat), web (Stripe), comp
--    (the PREMIUM_EMAILS list) and legacy (Pro from before this, with no
--    source on record). tier is premium while any part is active. 1.3.2 still
--    writes what Apple says on every start; from now on that write changes
--    only the apple part, so it can't drop a website subscriber to Free.
--    Step 2 stops taking it at all.
--
-- 3. What the next app version and the server use instead of whole rows:
--    my_profile() and my_dream_memory() for your own row, bio and tier columns
--    that other people can be shown, and username_taken() for signing up.
--
-- 4. Functions only the server can call, with the service key: set_plan_source,
--    grant_ai_credits, record_billing_event, get_dream_memory,
--    save_dream_memory, add_safety_report and note_old_app. And
--    check_and_increment_ai_quota is now the server's only. Any app could call
--    it before, on anyone's account, and spend their credits.
--
-- Signed-in people can still read whole rows after this step, their own and
-- other people's, because that's what 1.3.2 does (select *). Step 2 moves
-- dream memory and safety reports out of reach and locks plan and credit
-- writes; step 3 closes the rest once 1.3.2 is gone.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles is missing. This file is for the Nightlink database.';
  end if;
end $$;

-- ── Tables only the server reads ─────────────────────────────────────────────
-- Row level security is on with no policies, and apps get no grants, so only
-- the service key reaches them.

create table if not exists public.profile_private (
  id                      uuid primary key references public.profiles (id) on delete cascade,
  dream_memory            text,
  dream_memory_updated_at timestamptz,
  safety_reports          jsonb not null default '[]',
  old_app_seen_at         timestamptz,
  updated_at              timestamptz not null default now()
);

-- One row per payment event the server has acted on, so a retried webhook
-- never grants twice.
create table if not exists public.billing_events (
  key        text primary key,
  source     text not null,
  kind       text not null,
  user_id    uuid,
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.billing_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.profile_private  enable row level security;
alter table public.billing_events   enable row level security;
alter table public.billing_settings enable row level security;
revoke all on public.profile_private, public.billing_events, public.billing_settings from public, anon, authenticated;
grant all on public.profile_private, public.billing_events, public.billing_settings to service_role;

-- ── Columns other people can be shown ────────────────────────────────────────
-- The app shows other people's bio and Pro badge, which live inside settings
-- and subscription. These copy them out, so step 3 can let people read them
-- without the rest of either.

do $$
declare
  v_col text;
begin
  foreach v_col in array array['bio', 'tier'] loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = v_col
        and is_generated <> 'ALWAYS'
    ) then
      raise exception 'profiles.% already exists and isn''t the generated column this file adds. Rename it first.', v_col;
    end if;
  end loop;
end $$;

alter table public.profiles add column if not exists bio text
  generated always as (nullif(btrim(settings ->> 'bio'), '')) stored;
alter table public.profiles add column if not exists tier text
  generated always as (case when subscription ->> 'tier' = 'premium' then 'premium' else 'free' end) stored;

-- ── Plans remember where they came from ──────────────────────────────────────

-- The plan with these sources: tier is premium while any source is active,
-- and provider names the one that counts most, for code that reads it.
create or replace function public.plan_with_sources(p_plan jsonb, p_sources jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  with s as (
    select case when jsonb_typeof(p_sources) = 'object' then p_sources else '{}'::jsonb end as sources
  ),
  active as (
    select e.key
    from s, jsonb_each(s.sources) as e
    where jsonb_typeof(e.value) = 'object' and e.value -> 'active' = 'true'::jsonb
  )
  select (case when jsonb_typeof(p_plan) = 'object' then p_plan else '{}'::jsonb end - 'sources' - 'tier' - 'provider')
    || jsonb_build_object(
      'tier', case when exists (select 1 from active) then 'premium' else 'free' end,
      'provider', case
        when exists (select 1 from active where key = 'apple') then 'revenuecat'
        when exists (select 1 from active where key = 'web') then 'stripe'
        when exists (select 1 from active where key = 'comp') then 'comp'
        when exists (select 1 from active where key = 'legacy')
          then coalesce((select s.sources -> 'legacy' ->> 'provider' from s), 'legacy')
      end,
      'sources', (select sources from s))
$$;

-- The plan with one source replaced.
create or replace function public.plan_with_source(p_plan jsonb, p_source text, p_state jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select public.plan_with_sources(
    p_plan,
    case when jsonb_typeof(p_plan -> 'sources') = 'object' then p_plan -> 'sources' else '{}'::jsonb end
      || jsonb_build_object(p_source, case when jsonb_typeof(p_state) = 'object' then p_state else '{}'::jsonb end))
$$;

-- A plan from before sources, given its sources. What 1.3.2 wrote from the App
-- Store becomes the apple part; any other Pro becomes legacy, so nobody loses
-- Pro here. A plan that already has sources comes back as it is.
create or replace function public.plan_from_legacy(p_plan jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when jsonb_typeof(p_plan -> 'sources') = 'object' then p_plan
    when coalesce(p_plan ->> 'provider', '') = 'revenuecat' then public.plan_with_sources(p_plan,
      jsonb_build_object('apple', jsonb_build_object(
        'active', coalesce(p_plan ->> 'tier' = 'premium', false),
        'expiresAt', p_plan -> 'expiresAt',
        'from', 'app')))
    when p_plan ->> 'tier' = 'premium' then public.plan_with_sources(p_plan,
      jsonb_build_object('legacy', jsonb_build_object('active', true, 'provider', p_plan -> 'provider')))
    else public.plan_with_sources(p_plan, '{}'::jsonb)
  end
$$;

update public.profiles
set subscription = public.plan_from_legacy(subscription)
where jsonb_typeof(subscription -> 'sources') is distinct from 'object';

-- What an app may write to its own row. Apps are anon and authenticated, the
-- roles PostgREST uses for them; the service key, the dashboard and this
-- database's own security definer functions run as other roles and pass.
-- A new row starts on the free plan with no credits, whatever the app sent.
-- A plan the app writes is what
-- Apple says, which 1.3.2 sends on every start: it becomes the apple part and
-- nothing else. Step 2 replaces this function with one that ignores plan,
-- credit and usage writes from apps altogether.
create or replace function public.profiles_guard_billing()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.subscription := public.plan_with_sources('{}'::jsonb, '{}'::jsonb);
    new.ai_usage := '{"monthYear": "", "monthlyCount": 0, "creditBalance": 0}'::jsonb;
    return new;
  end if;

  if new.subscription is distinct from old.subscription then
    new.subscription := public.plan_with_source(
      public.plan_from_legacy(old.subscription),
      'apple',
      jsonb_build_object(
        'active', coalesce(new.subscription ->> 'tier' = 'premium', false),
        'expiresAt', new.subscription -> 'expiresAt',
        'from', 'app',
        'eventAt', floor(extract(epoch from clock_timestamp()) * 1000)));
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_billing on public.profiles;
create trigger profiles_guard_billing
before insert or update on public.profiles
for each row execute function public.profiles_guard_billing();

-- ── For the server only (service key) ────────────────────────────────────────

-- Sets one source of a user's plan and works out the tier again. An event
-- older than the one already applied for that source changes nothing, since
-- Stripe and RevenueCat don't promise to send events in order. Returns the
-- plan, or null when there's no such profile.
--
-- To end Pro that's on record from before sources (the legacy part), for one
-- account: select public.set_plan_source('<uid>', 'legacy', '{"active": false}');
create or replace function public.set_plan_source(p_user_id uuid, p_source text, p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan jsonb;
  v_prev jsonb;
  v_at numeric := nullif(p_state ->> 'eventAt', '')::numeric;
begin
  if p_source is null or p_source not in ('apple', 'web', 'comp', 'legacy') then
    raise exception 'unknown plan source: %', p_source using errcode = '22023';
  end if;

  select public.plan_from_legacy(subscription) into v_plan
  from public.profiles where id = p_user_id
  for update;
  if not found then
    return null;
  end if;

  v_prev := v_plan -> 'sources' -> p_source;
  if v_at is not null and jsonb_typeof(v_prev) = 'object'
     and nullif(v_prev ->> 'eventAt', '')::numeric > v_at then
    return v_plan;
  end if;

  v_plan := public.plan_with_source(v_plan, p_source,
    coalesce(p_state, '{}'::jsonb) || jsonb_build_object('updatedAt', now()));

  -- Pro from before sources ends with a website plan that takes it over. That
  -- covers payment link buyers who were given Pro by hand: once their
  -- subscription names their account (scripts/stripe-link-buyers.mjs), Stripe
  -- says whether it's paid for, and canceling ends Pro.
  if p_source = 'web' and p_state -> 'active' = 'true'::jsonb
     and v_plan -> 'sources' -> 'legacy' -> 'active' = 'true'::jsonb then
    v_plan := public.plan_with_source(v_plan, 'legacy',
      (v_plan -> 'sources' -> 'legacy') || jsonb_build_object('active', false, 'endedBy', 'web', 'updatedAt', now()));
  end if;

  update public.profiles set subscription = v_plan where id = p_user_id;
  return v_plan;
end;
$$;

-- Records a payment event. True the first time a key is seen.
create or replace function public.record_billing_event(
  p_key text, p_source text, p_kind text, p_user_id uuid, p_detail jsonb default '{}'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.billing_events (key, source, kind, user_id, detail)
  values (p_key, p_source, p_kind, p_user_id, coalesce(p_detail, '{}'::jsonb))
  on conflict (key) do nothing;
  return found;
end;
$$;

-- Adds a credit pack once per purchase key. Until step 2, Nightlink 1.3.2 adds
-- App Store packs to the row itself, so a RevenueCat purchase from before
-- step 2 is recorded but not added again.
create or replace function public.grant_ai_credits(
  p_user_id uuid, p_amount integer, p_key text, p_source text, p_purchased_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage jsonb;
  v_balance integer;
  v_locked_at timestamptz;
begin
  if p_amount is null or p_amount <= 0 or p_amount > 1000 then
    raise exception 'credit amount out of range: %', p_amount using errcode = '22023';
  end if;
  if coalesce(p_key, '') = '' then
    raise exception 'a purchase key is required' using errcode = '22023';
  end if;

  if not public.record_billing_event(p_key, p_source, 'credits', p_user_id,
       jsonb_build_object('amount', p_amount, 'purchasedAt', p_purchased_at)) then
    return jsonb_build_object('granted', false, 'reason', 'already_granted');
  end if;

  if p_source = 'revenuecat' then
    select (value #>> '{}')::timestamptz into v_locked_at
    from public.billing_settings where key = 'app_billing_writes_locked_at';
    if v_locked_at is null or coalesce(p_purchased_at, now()) < v_locked_at then
      update public.billing_events set detail = detail || '{"addedBy": "app"}'::jsonb where key = p_key;
      return jsonb_build_object('granted', false, 'reason', 'added_by_app');
    end if;
  end if;

  select coalesce(ai_usage, '{}'::jsonb) into v_usage
  from public.profiles where id = p_user_id
  for update;
  if not found then
    update public.billing_events set detail = detail || '{"noAccount": true}'::jsonb where key = p_key;
    return jsonb_build_object('granted', false, 'reason', 'no_account');
  end if;

  v_balance := coalesce(
    case when jsonb_typeof(v_usage -> 'creditBalance') = 'number' then floor((v_usage ->> 'creditBalance')::numeric)::integer end,
    0) + p_amount;
  update public.profiles
  set ai_usage = v_usage || jsonb_build_object('creditBalance', v_balance)
  where id = p_user_id;
  return jsonb_build_object('granted', true, 'creditBalance', v_balance);
end;
$$;

-- Dream memory, read and written by the AI route. Step 2 moves it into
-- profile_private and replaces both bodies; the server keeps calling these.
create or replace function public.get_dream_memory(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.dream_memory from public.profiles p where p.id = p_user_id
$$;

create or replace function public.save_dream_memory(p_user_id uuid, p_memory text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
  set dream_memory = p_memory, dream_memory_updated_at = now()
  where id = p_user_id
$$;

-- Keeps the newest 100 reports a person has filed. Step 2 moves them out of
-- settings, where anyone signed in could read who reported whom.
create or replace function public.add_safety_report(p_user_id uuid, p_report jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
  set settings = jsonb_set(
    coalesce(settings, '{}'::jsonb),
    '{safetyReports}',
    coalesce((
      select jsonb_agg(r.value order by r.n)
      from (
        select p_report as value, 0::bigint as n
        union all
        select e.value, e.n
        from jsonb_array_elements(
          case when jsonb_typeof(settings -> 'safetyReports') = 'array' then settings -> 'safetyReports' else '[]'::jsonb end
        ) with ordinality as e(value, n)
      ) r
      where r.n < 100
    ), '[]'::jsonb))
  where id = p_user_id
$$;

-- When an app from before the next version last asked for its plan. Step 3
-- refuses to run while anyone has in the last 14 days.
create or replace function public.note_old_app(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.profile_private (id, old_app_seen_at)
  select p.id, now() from public.profiles p where p.id = p_user_id
  on conflict (id) do update set old_app_seen_at = now(), updated_at = now()
$$;

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('set_plan_source', 'record_billing_event', 'grant_ai_credits', 'get_dream_memory',
                        'save_dream_memory', 'add_safety_report', 'note_old_app', 'check_and_increment_ai_quota')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ── For the next app version ─────────────────────────────────────────────────

-- Your own row, all of it. Step 3 stops letting apps read other people's
-- private columns, and Postgres can only grant columns to everyone or no one,
-- so your own private columns come through here.
create or replace function public.my_profile()
returns setof public.profiles
language sql
stable
security definer
set search_path = public
as $$
  select * from public.profiles where id = auth.uid()
$$;

create or replace function public.my_dream_memory()
returns table (dream_memory text, dream_memory_updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.dream_memory, p.dream_memory_updated_at from public.profiles p where p.id = auth.uid()
$$;

-- For the sign up screen, which runs before there's an account.
create or replace function public.username_taken(p_username text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where normalized_username = lower(btrim(coalesce(p_username, '')))
  )
$$;

revoke execute on function public.my_profile(), public.my_dream_memory() from public, anon;
grant execute on function public.my_profile(), public.my_dream_memory() to authenticated, service_role;
revoke execute on function public.username_taken(text) from public;
grant execute on function public.username_taken(text) to anon, authenticated, service_role;

-- ── Signed-out visitors ──────────────────────────────────────────────────────

revoke all on public.profiles from anon;
grant select (id, normalized_username, email, follower_ids, following_ids) on public.profiles to anon;

-- Policies on other tables run with the reader's own column rights. Name any
-- that read a profile column signed-out visitors no longer have, so a page
-- that reads those tables signed out isn't a surprise. The app has none.
do $$
declare
  r record;
begin
  for r in
    select distinct c.relname as table_name, pol.polname as policy_name, a.attname as column_name
    from pg_depend d
    join pg_policy pol on d.classid = 'pg_policy'::regclass and d.objid = pol.oid
    join pg_class c on c.oid = pol.polrelid
    join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
    where d.refobjid = 'public.profiles'::regclass
      and d.refobjsubid > 0
      and pol.polrelid <> 'public.profiles'::regclass
      and a.attname not in ('id', 'normalized_username', 'email', 'follower_ids', 'following_ids')
      and (pol.polroles = '{0}'::oid[] or 'anon'::regrole::oid = any (pol.polroles))
  loop
    raise notice 'Reading % signed out will now fail: policy % reads profiles.%.', r.table_name, r.policy_name, r.column_name;
  end loop;
end $$;

commit;
