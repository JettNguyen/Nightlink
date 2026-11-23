-- Follows, blocks and comments, checked by the database (11/23/2026).
--
-- Run once in the Supabase SQL editor. It runs as one transaction, and running
-- it again changes nothing further. It works with every app version: nothing
-- here changes what the app sends or reads.
--
-- 1. Following works again. On 5/26/2026 the follow functions were renamed to
--    take p_target_id and p_requester_id, but every app build sends target_id
--    and requester_id, so since then every follow, unfollow and follow request
--    approval has failed ("Could not find the function"). They take the app's
--    names now.
-- 2. A private account approves its followers. follow_user used to follow any
--    account at once when called directly; for a private account it now sends
--    a follow request instead, the way request_follow does.
-- 3. Blocking is kept by the database. Adding someone to your block list cuts
--    every follow and follow request between you, both ways. Someone you've
--    blocked can't see your dreams, comment on them, follow you, ask to follow
--    you, or send you a notice.
-- 4. The "hide from" list on a dream is kept by the database too, not only by
--    the app.
-- 5. Comments: you can read a comment only on a dream you can see (or your own
--    comment), and write one only on a dream you can see. The name, handle,
--    dream owner and dream title on a new comment come from the database, not
--    from the app, and it starts with no hearts. The author of an anonymous
--    dream comments on it with no name.
-- 6. Usage counting works again. There were two versions of
--    check_and_increment_ai_quota, and the server's call fits both, so every
--    call failed ("Could not choose the best candidate function", status 300 in
--    the API logs) and the server fell back to counting on its own, which takes
--    no lock: readings started together all got through, and a credit pack
--    bought in between could be lost. The older version (no Pro limit) goes.
--    The one left counts Pro readings to 30 a month, as the fallback did, and
--    gets a fixed search_path like the other functions.
--
-- Not changed here: an anonymous dream's row still carries its author's id,
-- the Pattern recognition notes still sit on the dream row, and every reader
-- of a dream can still see its "hide from" list. Each needs the app to read
-- dreams differently first.

begin;

-- ── Blocks ───────────────────────────────────────────────────────────────────

-- Whether this person has blocked whoever is asking. It only ever answers about
-- the asker, so it tells nobody who else someone has blocked. The row rules
-- below call it for signed-out visitors too, so everyone may run it.
create or replace function public.has_blocked_me(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and coalesce((
    select jsonb_typeof(p.settings -> 'blockedUserIds') = 'array'
       and (p.settings -> 'blockedUserIds') ? auth.uid()::text
    from public.profiles p
    where p.id = p_user
  ), false)
$$;

revoke all on function public.has_blocked_me(uuid) from public;
grant execute on function public.has_blocked_me(uuid) to anon, authenticated, service_role;

-- The ids in a block list, skipping anything that isn't an id.
create or replace function public.block_list(p_settings jsonb)
returns uuid[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_agg(x::uuid), '{}'::uuid[])
  from jsonb_array_elements_text(
    case when jsonb_typeof(p_settings -> 'blockedUserIds') = 'array'
         then p_settings -> 'blockedUserIds' else '[]'::jsonb end
  ) as x
  where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- When someone is added to a block list, every follow and follow request
-- between the two goes, both ways. The app only ever unfollowed one way.
create or replace function public.profiles_block_cuts_follows()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_added uuid[];
begin
  v_added := array(
    select x from unnest(public.block_list(new.settings)) as x
    where not (x = any(public.block_list(old.settings)))
  );
  if cardinality(v_added) = 0 then
    return new;
  end if;

  new.follower_ids := array(select x from unnest(coalesce(new.follower_ids, '{}'::uuid[])) as x where not (x = any(v_added)));
  new.following_ids := array(select x from unnest(coalesce(new.following_ids, '{}'::uuid[])) as x where not (x = any(v_added)));

  update public.profiles p
  set follower_ids = array_remove(coalesce(p.follower_ids, '{}'::uuid[]), new.id),
      following_ids = array_remove(coalesce(p.following_ids, '{}'::uuid[]), new.id)
  where p.id = any(v_added);

  delete from public.follow_requests fr
  where (fr.requester_id = new.id and fr.target_id = any(v_added))
     or (fr.target_id = new.id and fr.requester_id = any(v_added));

  return new;
end;
$$;

revoke all on function public.profiles_block_cuts_follows() from public, anon, authenticated;

drop trigger if exists profiles_block_cuts_follows on public.profiles;
create trigger profiles_block_cuts_follows
  before update of settings on public.profiles
  for each row execute function public.profiles_block_cuts_follows();

-- ── Following ────────────────────────────────────────────────────────────────
-- Each function is dropped and made again because Postgres can't rename a
-- function's inputs in place. "#variable_conflict use_column" makes a bare
-- target_id or requester_id in a query mean the column; the input is copied to
-- a v_ variable first.

drop function if exists public.request_follow(uuid);
create function public.request_follow(target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_me uuid := auth.uid();
  v_target uuid := request_follow.target_id;
  v_visibility text;
  v_followers uuid[];
begin
  if v_me is null then
    raise exception 'Not authenticated';
  end if;
  if v_target is null or v_target = v_me then
    raise exception 'Invalid target user';
  end if;

  select p.account_visibility, p.follower_ids into v_visibility, v_followers
  from public.profiles p where p.id = v_target;
  if not found then
    raise exception 'Target profile not found';
  end if;
  if public.has_blocked_me(v_target) then
    raise exception 'Unable to follow this account' using errcode = '42501';
  end if;

  if coalesce(v_visibility, 'private') = 'private' and not (v_me = any(coalesce(v_followers, '{}'::uuid[]))) then
    insert into public.follow_requests (requester_id, target_id, status)
    values (v_me, v_target, 'pending')
    on conflict (requester_id, target_id)
    do update set status = 'pending', updated_at = now();
    return jsonb_build_object('status', 'pending');
  end if;

  update public.profiles p
  set following_ids = array(select distinct x from unnest(coalesce(p.following_ids, '{}'::uuid[]) || v_target) as x)
  where p.id = v_me;
  update public.profiles p
  set follower_ids = array(select distinct x from unnest(coalesce(p.follower_ids, '{}'::uuid[]) || v_me) as x)
  where p.id = v_target;
  delete from public.follow_requests fr where fr.requester_id = v_me and fr.target_id = v_target;

  return jsonb_build_object('status', 'following');
end;
$$;

-- Same as request_follow. The app calls this one for public accounts, but a
-- private account still only gets a request, whoever calls it.
drop function if exists public.follow_user(uuid);
create function public.follow_user(target_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.request_follow(follow_user.target_id)
$$;

drop function if exists public.unfollow_user(uuid);
create function public.unfollow_user(target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_me uuid := auth.uid();
  v_target uuid := unfollow_user.target_id;
begin
  if v_me is null then
    raise exception 'Not authenticated';
  end if;
  if v_target is null or v_target = v_me then
    raise exception 'Invalid target user';
  end if;

  update public.profiles p
  set following_ids = array_remove(coalesce(p.following_ids, '{}'::uuid[]), v_target)
  where p.id = v_me;
  update public.profiles p
  set follower_ids = array_remove(coalesce(p.follower_ids, '{}'::uuid[]), v_me)
  where p.id = v_target;
  delete from public.follow_requests fr where fr.requester_id = v_me and fr.target_id = v_target;

  return jsonb_build_object('status', 'unfollowed');
end;
$$;

drop function if exists public.cancel_follow_request(uuid);
create function public.cancel_follow_request(target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_me uuid := auth.uid();
  v_target uuid := cancel_follow_request.target_id;
begin
  if v_me is null then
    raise exception 'Not authenticated';
  end if;

  update public.follow_requests fr
  set status = 'cancelled', updated_at = now()
  where fr.requester_id = v_me and fr.target_id = v_target and fr.status = 'pending';

  return jsonb_build_object('status', 'cancelled');
end;
$$;

drop function if exists public.accept_follow_request(uuid);
create function public.accept_follow_request(requester_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_me uuid := auth.uid();
  v_requester uuid := accept_follow_request.requester_id;
begin
  if v_me is null then
    raise exception 'Not authenticated';
  end if;

  update public.follow_requests fr
  set status = 'accepted', updated_at = now()
  where fr.requester_id = v_requester and fr.target_id = v_me and fr.status = 'pending';
  if not found then
    return jsonb_build_object('status', 'missing_request');
  end if;

  update public.profiles p
  set following_ids = array(select distinct x from unnest(coalesce(p.following_ids, '{}'::uuid[]) || v_me) as x)
  where p.id = v_requester;
  update public.profiles p
  set follower_ids = array(select distinct x from unnest(coalesce(p.follower_ids, '{}'::uuid[]) || v_requester) as x)
  where p.id = v_me;

  return jsonb_build_object('status', 'accepted');
end;
$$;

drop function if exists public.decline_follow_request(uuid);
create function public.decline_follow_request(requester_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_me uuid := auth.uid();
  v_requester uuid := decline_follow_request.requester_id;
begin
  if v_me is null then
    raise exception 'Not authenticated';
  end if;

  update public.follow_requests fr
  set status = 'declined', updated_at = now()
  where fr.requester_id = v_requester and fr.target_id = v_me and fr.status = 'pending';

  return jsonb_build_object('status', 'declined');
end;
$$;

revoke all on function
  public.request_follow(uuid), public.follow_user(uuid), public.unfollow_user(uuid),
  public.cancel_follow_request(uuid), public.accept_follow_request(uuid), public.decline_follow_request(uuid)
  from public, anon;
grant execute on function
  public.request_follow(uuid), public.follow_user(uuid), public.unfollow_user(uuid),
  public.cancel_follow_request(uuid), public.accept_follow_request(uuid), public.decline_follow_request(uuid)
  to authenticated, service_role;

-- Asking to follow someone who blocked you, by writing the request directly.
drop policy if exists follow_requests_insert on public.follow_requests;
create policy follow_requests_insert on public.follow_requests
  for insert
  with check (
    auth.uid() = requester_id
    and requester_id <> target_id
    and status = 'pending'
    and not public.has_blocked_me(target_id)
  );

-- ── Dreams ───────────────────────────────────────────────────────────────────
-- As before, plus: the people a dream is hidden from, and the people its owner
-- has blocked, can't read it.

drop policy if exists dreams_read on public.dreams;
create policy dreams_read on public.dreams
  for select
  using (
    auth.uid() = user_id
    or (
      not coalesce(auth.uid() = any(excluded_viewer_ids), false)
      and not public.has_blocked_me(user_id)
      and (
        visibility = any (array['public', 'anonymous'])
        or (
          auth.uid() is not null and visibility = 'followers'
          and auth.uid() = any(coalesce((select p.follower_ids from public.profiles p where p.id = dreams.user_id), '{}'::uuid[]))
        )
        or (
          auth.uid() is not null and visibility = 'mutuals'
          and auth.uid() = any(coalesce((select p.follower_ids from public.profiles p where p.id = dreams.user_id), '{}'::uuid[]))
          and auth.uid() = any(coalesce((select p.following_ids from public.profiles p where p.id = dreams.user_id), '{}'::uuid[]))
        )
      )
    )
  );

-- ── Comments ─────────────────────────────────────────────────────────────────
-- "A dream you can see" is checked by reading the dream under the rule above.

drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments
  for select
  using (
    auth.uid() is not null
    and (
      auth.uid() = user_id
      or exists (select 1 from public.dreams d where d.id = comments.dream_id)
    )
  );

drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments
  for insert
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.dreams d where d.id = comments.dream_id)
  );

-- What a new comment says about who wrote it and where, from the database.
create or replace function public.comments_as_yourself()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dream record;
  v_parent record;
begin
  select d.user_id, d.visibility, d.title, d.ai_title, d.ai_generated into v_dream
  from public.dreams d where d.id = new.dream_id;
  if not found then
    raise exception 'Dream not found' using errcode = '23503';
  end if;

  if v_dream.visibility = 'anonymous' and new.user_id = v_dream.user_id then
    new.author_display_name := null;
    new.author_username := null;
  else
    select p.display_name, p.username into new.author_display_name, new.author_username
    from public.profiles p where p.id = new.user_id;
  end if;

  new.dream_owner_id := v_dream.user_id;
  new.dream_owner_username := case
    when v_dream.visibility = 'anonymous' then ''
    else coalesce((select p.username from public.profiles p where p.id = v_dream.user_id), '')
  end;
  new.dream_title_snapshot := coalesce(
    nullif(btrim(v_dream.title), ''),
    case when v_dream.ai_generated then nullif(btrim(v_dream.ai_title), '') end,
    'Untitled dream');
  new.heart_count := 0;
  new.heart_user_ids := '{}'::uuid[];

  if new.parent_comment_id is not null then
    select c.user_id, c.dream_id into v_parent from public.comments c where c.id = new.parent_comment_id;
    if not found or v_parent.dream_id <> new.dream_id then
      raise exception 'That reply is not on this dream' using errcode = '23503';
    end if;
    new.parent_comment_user_id := v_parent.user_id;
  else
    new.parent_comment_user_id := null;
  end if;

  return new;
end;
$$;

revoke all on function public.comments_as_yourself() from public, anon, authenticated;

drop trigger if exists comments_as_yourself on public.comments;
create trigger comments_as_yourself
  before insert on public.comments
  for each row execute function public.comments_as_yourself();

-- ── Notices ──────────────────────────────────────────────────────────────────

drop policy if exists activity_insert on public.activity;
create policy activity_insert on public.activity
  for insert
  with check (
    auth.uid() is not null
    and actor_id = auth.uid()
    and not public.has_blocked_me(target_user_id)
  );

-- ── Usage counting ───────────────────────────────────────────────────────────

drop function if exists public.check_and_increment_ai_quota(uuid, text, integer);
alter function public.check_and_increment_ai_quota(uuid, text, integer, integer) set search_path = public;

commit;

notify pgrst, 'reload schema';
