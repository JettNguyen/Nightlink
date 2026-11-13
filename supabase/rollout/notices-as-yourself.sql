-- ============================================================================
-- Notices, only from yourself
-- ============================================================================
--
-- Run in Supabase's SQL editor, once. Like reactions-as-yourself.sql, it
-- doesn't need the profile privacy steps and they don't touch what it changes,
-- so it can run before, between or after steps 1 to 3. Running it twice
-- changes nothing more.
--
-- Until it runs, anyone signed in can add a notice to anyone's activity with
-- any sender on it: "Sam reacted to your dream" when Sam didn't.
--
-- Safe for Nightlink 1.3.2 from the App Store, the website and the next app
-- version. All of them send the signed-in person's own id as the sender
-- (src/services/ActivityService.js, unchanged since 1.3.2).
--
-- What it does
--
-- 1. A notice can only be added with yourself as its sender (actor_id is
--    auth.uid()). Anything else is refused.
--
-- 2. The sender's name and username on a new notice come from their profile,
--    whatever the app sent. Some app pages sent the sender's email when they
--    had no name to hand, which put that email on someone else's notice.
--
-- Not changed: the dream title and emoji on a notice still come from the app,
-- so a real sender can still put a made-up title on one. Taking the title from
-- the dream instead could show someone the title of a dream they can't see.
-- The notify function (supabase/functions/notify) gets the same fix for push
-- notifications.
--
-- Before changing anything it checks that the tables have the columns it uses,
-- that row level security is on for activity, and that no other policy lets
-- apps add notices, and stops with nothing changed if not. Fold this into
-- schema.sql with the others after step 3.
-- ============================================================================

begin;

do $$
declare
  v_problems text := '';
  r record;
begin
  -- The columns the policy and the trigger use.
  for r in
    select need.table_name, need.column_name, need.type_name
    from (values
      ('activity', 'actor_id', 'uuid'),
      ('activity', 'actor_display_name', 'text'),
      ('activity', 'actor_username', 'text'),
      ('profiles', 'display_name', 'text'),
      ('profiles', 'username', 'text')
    ) as need (table_name, column_name, type_name)
    where not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = need.table_name
        and c.column_name = need.column_name and c.udt_name = need.type_name
    )
  loop
    v_problems := v_problems || format(E'\n  no %s.%s of type %s', r.table_name, r.column_name, r.type_name);
  end loop;

  -- Without row level security no policy applies, so this one wouldn't either.
  if exists (select 1 from pg_class where oid = to_regclass('public.activity') and not relrowsecurity) then
    v_problems := v_problems || E'\n  row level security is off on activity';
  end if;

  -- An app may add a row when any one policy allows it, so another policy that
  -- allows inserts would keep the hole open.
  for r in
    select pol.polname
    from pg_policy pol
    where pol.polrelid = to_regclass('public.activity')
      and pol.polcmd in ('a', '*')
      and pol.polpermissive
      and pol.polname <> 'activity_insert'
  loop
    v_problems := v_problems || format(E'\n  another policy lets apps add notices: %s', r.polname);
  end loop;

  if v_problems <> '' then
    raise exception 'Nothing was changed. The database isn''t what this file expects:%', v_problems
      using hint = 'Compare those with supabase/schema.sql and fix this file before running it again.';
  end if;
end $$;

drop policy if exists "activity_insert" on public.activity;
create policy "activity_insert" on public.activity for insert
  with check (auth.uid() is not null and actor_id = auth.uid());

-- The sender's name on a notice is the one on their profile.
create or replace function public.activity_sender_names()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.actor_id is not null then
    select p.display_name, p.username
    into new.actor_display_name, new.actor_username
    from public.profiles p
    where p.id = new.actor_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.activity_sender_names() from public, anon, authenticated;

drop trigger if exists activity_sender_names on public.activity;
create trigger activity_sender_names
  before insert on public.activity
  for each row execute function public.activity_sender_names();

commit;
