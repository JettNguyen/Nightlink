-- ============================================================================
-- Profile privacy, step 3 of 3: close
-- ============================================================================
--
-- Run in Supabase's SQL editor only once Nightlink 1.3.2 is gone: the next
-- version is on the App Store and nobody has opened 1.3.2 (or a website page
-- older than this change) for 14 days. This step BREAKS 1.3.2, which reads
-- whole rows with select *. It refuses to run while the server has seen an
-- old app in the last 14 days. To run it anyway, put this line first:
--   set nightlink.close_anyway = 'yes';
--
-- What it does
--
-- 1. Signed-in people can read only these columns of a profile, their own
--    included: id, display_name, username, normalized_username, photo_url,
--    avatar_icon, avatar_background, avatar_color, account_visibility,
--    following_ids, follower_ids, bio and tier. That's what the app shows
--    about other people, plus what it needs to decide who sees which dream.
--    Your own email, settings, plan, credits, push tokens and the rest come
--    from my_profile(), and dream memory from my_dream_memory().
--
-- 2. Signed-out visitors can't read profiles at all. The app signs in with a
--    username through /api/account and checks a new username with
--    username_taken().
--
-- Writes are unchanged: apps still update their own row (the plan, credits
-- and usage stay locked by step 2), and the server still reads and writes
-- everything with the service key.
-- ============================================================================

begin;

do $$
declare
  v_public constant text[] := array[
    'id', 'display_name', 'username', 'normalized_username', 'photo_url', 'avatar_icon',
    'avatar_background', 'avatar_color', 'account_visibility', 'following_ids', 'follower_ids', 'bio', 'tier'
  ];
  v_ours constant text[] := array[
    'profiles_guard_billing', 'plan_with_sources', 'plan_with_source', 'plan_from_legacy'
  ];
  v_recent integer;
  v_problems text := '';
  r record;
begin
  if not exists (select 1 from public.billing_settings where key = 'app_billing_writes_locked_at') then
    raise exception 'Run 2-profile-privacy-lock.sql first.';
  end if;

  select count(*) into v_recent
  from public.profile_private
  where old_app_seen_at > now() - interval '14 days';
  if v_recent > 0 and coalesce(current_setting('nightlink.close_anyway', true), '') <> 'yes' then
    raise exception '% people opened Nightlink 1.3.2, or a website page from before this change, in the last 14 days. They would break. Wait, or see the top of this file to run it anyway.', v_recent;
  end if;

  -- Policies and invoker views run with the reader's own column rights, so
  -- one that reads a column about to close would start failing.
  for r in
    select distinct format('policy %s on %s reads profiles.%s', pol.polname, c.relname, a.attname) as problem
    from pg_depend d
    join pg_policy pol on d.classid = 'pg_policy'::regclass and d.objid = pol.oid
    join pg_class c on c.oid = pol.polrelid
    join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
    where d.refobjid = 'public.profiles'::regclass and d.refobjsubid > 0
      and a.attname <> all (v_public)
    union
    select distinct format('view %s reads profiles.%s', v.relname, a.attname)
    from pg_depend d
    join pg_rewrite rw on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid
    join pg_class v on v.oid = rw.ev_class
    join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
    where d.refobjid = 'public.profiles'::regclass and d.refobjsubid > 0
      and v.oid <> 'public.profiles'::regclass
      and a.attname <> all (v_public)
      and coalesce(v.reloptions, '{}') && array['security_invoker=true', 'security_invoker=on']
    union
    -- Functions that read profiles as whoever calls them can't be checked
    -- column by column; any that name the table are listed to look at.
    select format('function %s reads profiles as its caller', p.oid::regprocedure)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and not p.prosecdef and l.lanname in ('sql', 'plpgsql')
      and p.proname <> all (v_ours)
      and p.prosrc ~* '\mprofiles\M'
  loop
    v_problems := v_problems || E'\n  ' || r.problem;
  end loop;
  if v_problems <> '' and coalesce(current_setting('nightlink.close_anyway', true), '') <> 'yes' then
    raise exception 'These would stop working for signed-in people:%', v_problems;
  end if;
end $$;

revoke select on public.profiles from anon, authenticated;
grant select (
  id, display_name, username, normalized_username, photo_url, avatar_icon,
  avatar_background, avatar_color, account_visibility, following_ids, follower_ids, bio, tier
) on public.profiles to authenticated;

commit;
