-- ============================================================================
-- Profile privacy, step 2 of 3: lock
-- ============================================================================
--
-- Run in Supabase's SQL editor once step 1 is in, the code that uses it is
-- live on nightlink.dev, and RevenueCat's webhook reaches the server. It
-- refuses to run until RevenueCat has sent at least one event (its "Send
-- test event" button is enough), because from here on the server is the only
-- thing that turns on Pro or adds credits bought in the iPhone app.
-- Safe for Nightlink 1.3.2.
--
-- What it does
--
-- 1. Apps can no longer change their plan, AI credits or usage. A write of
--    subscription, ai_usage or premium_emails from an app keeps the value
--    that was there, without an error, so 1.3.2's App Store sync and its
--    credit pack write quietly do nothing. The server sets plans from Stripe's
--    and RevenueCat's webhooks and adds credits once per purchase.
--
-- 2. Dream memory moves to profile_private. Two owner-only functions take the
--    columns' names, dream_memory(profiles) and dream_memory_updated_at(profiles),
--    so PostgREST still answers 1.3.2's Dream Insights query
--    (select=subscription,dream_memory,dream_memory_updated_at) for your own
--    row and gives null for anyone else's. select * no longer includes them.
--
-- 3. Safety reports leave settings for profile_private, where only the server
--    reads them. Anyone signed in could read who reported whom before.
--
-- 4. premium_emails moves to profile_private too and is emptied on profiles.
--    Nothing reads it.
--
-- Signed-in people can still read the rest of other people's rows (email,
-- settings, plan, usage, push tokens) until step 3, because 1.3.2 reads whole
-- rows with select *.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.profile_private') is null then
    raise exception 'Run 1-profile-privacy-add.sql first.';
  end if;
  if not exists (select 1 from public.billing_events where source = 'revenuecat') then
    raise exception 'RevenueCat hasn''t reached the server yet. In RevenueCat, open the webhook for https://www.nightlink.dev/api/revenuecat and send a test event, then run this again.';
  end if;
end $$;

-- From now on RevenueCat purchases are the server's to add (see grant_ai_credits).
insert into public.billing_settings (key, value)
values ('app_billing_writes_locked_at', to_jsonb(now()))
on conflict (key) do nothing;

-- What 1.3.2 wrote from the phone no longer outranks RevenueCat's own events.
update public.profiles
set subscription = jsonb_set(subscription, '{sources,apple}', (subscription -> 'sources' -> 'apple') - 'eventAt')
where subscription -> 'sources' -> 'apple' ->> 'from' = 'app';

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
    new.premium_emails := '{}';
    new.settings := coalesce(new.settings, '{}'::jsonb) - 'safetyReports';
    return new;
  end if;

  new.subscription := old.subscription;
  new.ai_usage := old.ai_usage;
  new.premium_emails := old.premium_emails;
  -- An app that loaded settings before this step would write the reports back.
  new.settings := coalesce(new.settings, '{}'::jsonb) - 'safetyReports';
  return new;
end;
$$;

-- ── Dream memory ─────────────────────────────────────────────────────────────

insert into public.profile_private (id, dream_memory, dream_memory_updated_at)
select id, dream_memory, dream_memory_updated_at
from public.profiles
where dream_memory is not null or dream_memory_updated_at is not null
on conflict (id) do update
set dream_memory = excluded.dream_memory,
    dream_memory_updated_at = excluded.dream_memory_updated_at,
    updated_at = now();

-- These read the columns about to go.
drop function if exists public.my_dream_memory();
drop function if exists public.get_dream_memory(uuid);
drop function if exists public.save_dream_memory(uuid, text);

alter table public.profiles
  drop column if exists dream_memory,
  drop column if exists dream_memory_updated_at;

create or replace function public.dream_memory(p public.profiles)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select pp.dream_memory
  from public.profile_private pp
  where pp.id = p.id and (p.id = auth.uid() or auth.role() = 'service_role')
$$;

create or replace function public.dream_memory_updated_at(p public.profiles)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select pp.dream_memory_updated_at
  from public.profile_private pp
  where pp.id = p.id and (p.id = auth.uid() or auth.role() = 'service_role')
$$;

create function public.my_dream_memory()
returns table (dream_memory text, dream_memory_updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select pp.dream_memory, pp.dream_memory_updated_at
  from public.profile_private pp
  where pp.id = auth.uid()
$$;

create function public.get_dream_memory(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select pp.dream_memory from public.profile_private pp where pp.id = p_user_id
$$;

create function public.save_dream_memory(p_user_id uuid, p_memory text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.profile_private (id, dream_memory, dream_memory_updated_at)
  select p.id, p_memory, now() from public.profiles p where p.id = p_user_id
  on conflict (id) do update
  set dream_memory = excluded.dream_memory,
      dream_memory_updated_at = excluded.dream_memory_updated_at,
      updated_at = now()
$$;

revoke execute on function public.dream_memory(public.profiles), public.dream_memory_updated_at(public.profiles),
  public.my_dream_memory() from public, anon;
grant execute on function public.dream_memory(public.profiles), public.dream_memory_updated_at(public.profiles),
  public.my_dream_memory() to authenticated, service_role;
revoke execute on function public.get_dream_memory(uuid), public.save_dream_memory(uuid, text) from public, anon, authenticated;
grant execute on function public.get_dream_memory(uuid), public.save_dream_memory(uuid, text) to service_role;

-- ── Safety reports ───────────────────────────────────────────────────────────

insert into public.profile_private (id, safety_reports)
select id, settings -> 'safetyReports'
from public.profiles
where jsonb_typeof(settings -> 'safetyReports') = 'array'
on conflict (id) do update
set safety_reports = excluded.safety_reports, updated_at = now();

update public.profiles
set settings = settings - 'safetyReports'
where settings ? 'safetyReports';

create or replace function public.add_safety_report(p_user_id uuid, p_report jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.profile_private as pp (id, safety_reports)
  select p.id, jsonb_build_array(p_report) from public.profiles p where p.id = p_user_id
  on conflict (id) do update
  set safety_reports = coalesce((
        select jsonb_agg(r.value order by r.n)
        from (
          select p_report as value, 0::bigint as n
          union all
          select e.value, e.n
          from jsonb_array_elements(
            case when jsonb_typeof(pp.safety_reports) = 'array' then pp.safety_reports else '[]'::jsonb end
          ) with ordinality as e(value, n)
        ) r
        where r.n < 100
      ), '[]'::jsonb),
      updated_at = now()
$$;

-- ── premium_emails ───────────────────────────────────────────────────────────

insert into public.profile_private (id, premium_emails)
select id, premium_emails
from public.profiles
where premium_emails <> '{}'
on conflict (id) do update
set premium_emails = excluded.premium_emails, updated_at = now();

update public.profiles set premium_emails = '{}' where premium_emails <> '{}';

commit;
