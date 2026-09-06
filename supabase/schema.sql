-- ============================================================
-- Nightlink: Supabase PostgreSQL Schema
-- Run this in the Supabase SQL editor (Dashboard → SQL editor)
-- ============================================================

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ============================================================
-- PROFILES (mirrors auth.users, one row per user)
-- ============================================================
create table if not exists public.profiles (
  id                   uuid primary key references auth.users on delete cascade,
  email                text,
  display_name         text not null default 'Dreamer',
  username             text unique not null,
  normalized_username  text unique not null,
  photo_url            text,
  avatar_icon          text,
  avatar_background    text,
  avatar_color         text,
  is_anonymous         boolean not null default false,
  settings             jsonb not null default '{}',
  subscription         jsonb not null default '{"tier":"free"}',
  ai_usage             jsonb not null default '{"monthYear":"","monthlyCount":0,"creditBalance":0}',
  feed_seen_at_ms      bigint,
  fcm_tokens           text[] not null default '{}',
  following_ids        uuid[] not null default '{}',
  follower_ids         uuid[] not null default '{}',
  account_visibility   text not null default 'private'
                         check (account_visibility in ('private','public')),
  allow_anonymous_sharing boolean not null default true,
  premium_emails       text[] not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.profiles add column if not exists dream_memory text;
alter table public.profiles add column if not exists dream_memory_updated_at timestamptz;
alter table public.profiles add column if not exists account_visibility text;
update public.profiles set account_visibility = coalesce(account_visibility, 'private');
alter table public.profiles alter column account_visibility set default 'private';
alter table public.profiles alter column account_visibility set not null;
alter table public.profiles drop constraint if exists profiles_account_visibility_check;
alter table public.profiles
  add constraint profiles_account_visibility_check
  check (account_visibility in ('private','public'));

-- ============================================================
-- DREAMS
-- ============================================================
create table if not exists public.dreams (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  title                text not null default '',
  content              text not null default '',
  visibility           text not null default 'private'
                         check (visibility in ('private','public','followers','mutuals','anonymous')),
  ai_generated         boolean not null default false,
  ai_title             text,
  ai_insights          text,
  tags                 jsonb not null default '[]',
  reaction_counts      jsonb not null default '{}',
  viewer_reactions     jsonb not null default '{}',
  excluded_viewer_ids  uuid[] not null default '{}',
  tagged_user_ids      uuid[] not null default '{}',
  tagged_users         jsonb not null default '[]',
  author_username      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.dreams add column if not exists comment_count integer not null default 0;
alter table public.dreams add column if not exists ai_connections jsonb;
alter table public.dreams add column if not exists memory_indexed boolean not null default false;

-- Backfill comment_count for any dreams that had comments before the trigger was created
update public.dreams d
set comment_count = (select count(*) from public.comments c where c.dream_id = d.id)
where comment_count = 0
  and exists (select 1 from public.comments c where c.dream_id = d.id);

create index if not exists dreams_user_id_created_at_idx on public.dreams (user_id, created_at desc);
create index if not exists dreams_visibility_created_at_idx on public.dreams (visibility, created_at desc);
-- The profile "Tagged" tab runs `tagged_user_ids @> array[...]` on every profile
-- view. Without a GIN index that is a sequential scan of the whole dreams table.
create index if not exists dreams_tagged_user_ids_idx on public.dreams using gin (tagged_user_ids);

-- ============================================================
-- COMMENTS
-- ============================================================
create table if not exists public.comments (
  id                     uuid primary key default gen_random_uuid(),
  dream_id               uuid not null references public.dreams(id) on delete cascade,
  dream_owner_id         uuid references public.profiles(id),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  author_display_name    text,
  author_username        text,
  dream_owner_username   text,
  dream_title_snapshot   text,
  content                text not null,
  parent_comment_id      uuid references public.comments(id),
  parent_comment_user_id uuid references public.profiles(id),
  mentions               uuid[] not null default '{}',
  mention_handles        text[] not null default '{}',
  activity_target_ids    uuid[] not null default '{}',
  heart_count            integer not null default 0,
  heart_user_ids         uuid[] not null default '{}',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists comments_dream_id_created_at_idx on public.comments (dream_id, created_at asc);

-- Trigger: keep dreams.comment_count in sync with comments table
create or replace function public.update_dream_comment_count()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update public.dreams set comment_count = comment_count + 1 where id = NEW.dream_id;
  elsif tg_op = 'DELETE' then
    update public.dreams set comment_count = greatest(comment_count - 1, 0) where id = OLD.dream_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_dream_comment_count on public.comments;
create trigger trg_dream_comment_count
after insert or delete on public.comments
for each row execute function public.update_dream_comment_count();

-- ============================================================
-- ACTIVITY (inbox per user)
-- ============================================================
create table if not exists public.activity (
  id                   uuid primary key default gen_random_uuid(),
  target_user_id       uuid not null references public.profiles(id) on delete cascade,
  actor_id             uuid references public.profiles(id),
  actor_display_name   text,
  actor_username       text,
  type                 text not null
                         check (type in ('reaction','commentReaction','mention','reply','comment','dreamUpdate','follow','tag')),
  emoji                text,
  dream_id             uuid references public.dreams(id),
  dream_owner_id       uuid references public.profiles(id),
  dream_title_snapshot text,
  comment_id           uuid references public.comments(id),
  read                 boolean not null default false,
  read_at              timestamptz,
  created_at           timestamptz not null default now()
);

create index if not exists activity_target_user_id_created_at_idx on public.activity (target_user_id, created_at desc);

-- ============================================================
-- FOLLOW REQUESTS
-- ============================================================
create table if not exists public.follow_requests (
  id                   uuid primary key default gen_random_uuid(),
  requester_id         uuid not null references public.profiles(id) on delete cascade,
  target_id            uuid not null references public.profiles(id) on delete cascade,
  status               text not null default 'pending'
                         check (status in ('pending','accepted','declined','cancelled')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (requester_id, target_id),
  check (requester_id <> target_id)
);

create index if not exists follow_requests_target_status_idx on public.follow_requests (target_id, status, created_at desc);
create index if not exists follow_requests_requester_status_idx on public.follow_requests (requester_id, status, created_at desc);

-- keep activity type constraint in sync on existing databases
update public.activity
set type = 'mention'
where type not in ('reaction','commentReaction','mention','reply','comment','dreamUpdate','follow','tag');

alter table public.activity drop constraint if exists activity_type_check;
alter table public.activity
  add constraint activity_type_check
  check (type in ('reaction','commentReaction','mention','reply','comment','dreamUpdate','follow','tag'));

-- keep dreams visibility constraint in sync on existing databases
-- Step 1: temporarily allow both legacy and new visibility values.
alter table public.dreams drop constraint if exists dreams_visibility_check;
alter table public.dreams
  add constraint dreams_visibility_check
  check (visibility in ('private','public','following','followers','mutuals','anonymous'));

-- Step 2: migrate legacy values.
update public.dreams
set visibility = 'mutuals'
where visibility = 'following';

-- Step 3: normalize any unexpected legacy values to private.
update public.dreams
set visibility = 'private'
where visibility not in ('private','public','followers','mutuals','anonymous');

-- Step 4: enforce final visibility set.
alter table public.dreams drop constraint if exists dreams_visibility_check;
alter table public.dreams
  add constraint dreams_visibility_check
  check (visibility in ('private','public','followers','mutuals','anonymous'));

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles enable row level security;
alter table public.dreams    enable row level security;
alter table public.comments  enable row level security;
alter table public.activity  enable row level security;
alter table public.follow_requests enable row level security;

-- profiles: anyone can read (needed for usernames, search); only owner can update
drop policy if exists "profiles_read" on public.profiles;
drop policy if exists "profiles_insert" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_read"   on public.profiles for select using (true);
create policy "profiles_insert" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update" on public.profiles for update using (auth.uid() = id);

-- dreams: owner can do anything; others can read non-private (app enforces fine-grained access)
drop policy if exists "dreams_owner" on public.dreams;
drop policy if exists "dreams_read" on public.dreams;
create policy "dreams_owner"    on public.dreams for all    using (auth.uid() = user_id);
create policy "dreams_read" on public.dreams for select using (
  auth.uid() = user_id
  or visibility in ('public','anonymous')
  or (
    auth.uid() is not null
    and visibility = 'followers'
    and auth.uid() = any(coalesce((select p.follower_ids from public.profiles p where p.id = public.dreams.user_id), '{}'::uuid[]))
  )
  or (
    auth.uid() is not null
    and visibility = 'mutuals'
    and auth.uid() = any(coalesce((select p.follower_ids from public.profiles p where p.id = public.dreams.user_id), '{}'::uuid[]))
    and auth.uid() = any(coalesce((select p.following_ids from public.profiles p where p.id = public.dreams.user_id), '{}'::uuid[]))
  )
);

-- comments: owner or dream-owner can delete; anyone authed can read/insert
drop policy if exists "comments_read" on public.comments;
drop policy if exists "comments_insert" on public.comments;
drop policy if exists "comments_delete" on public.comments;
create policy "comments_read"   on public.comments for select using (auth.uid() is not null);
create policy "comments_insert" on public.comments for insert with check (auth.uid() = user_id);
create policy "comments_delete" on public.comments for delete
  using (auth.uid() = user_id or auth.uid() = dream_owner_id);

-- activity: only target user can read; anyone authed can insert (push-style)
drop policy if exists "activity_read" on public.activity;
drop policy if exists "activity_insert" on public.activity;
drop policy if exists "activity_update" on public.activity;
drop policy if exists "activity_delete" on public.activity;
create policy "activity_read"   on public.activity for select using (auth.uid() = target_user_id);
create policy "activity_insert" on public.activity for insert with check (auth.uid() is not null);
create policy "activity_update" on public.activity for update using (auth.uid() = target_user_id);
create policy "activity_delete" on public.activity for delete using (auth.uid() = target_user_id);

drop policy if exists "follow_requests_read" on public.follow_requests;
drop policy if exists "follow_requests_insert" on public.follow_requests;
drop policy if exists "follow_requests_update" on public.follow_requests;
drop policy if exists "follow_requests_delete" on public.follow_requests;
create policy "follow_requests_read" on public.follow_requests
  for select using (auth.uid() = requester_id or auth.uid() = target_id);
create policy "follow_requests_insert" on public.follow_requests
  for insert with check (auth.uid() = requester_id and requester_id <> target_id and status = 'pending');
create policy "follow_requests_update" on public.follow_requests
  for update using (auth.uid() = target_id)
  with check (auth.uid() = target_id and status in ('accepted','declined'));
create policy "follow_requests_delete" on public.follow_requests
  for delete using (auth.uid() = requester_id or auth.uid() = target_id);

-- ============================================================
-- PL/pgSQL FUNCTIONS
-- ============================================================

-- Ensure follow RPCs can be recreated even if legacy return types differ.
drop function if exists public.request_follow(uuid);
drop function if exists public.follow_user(uuid);
drop function if exists public.unfollow_user(uuid);
drop function if exists public.cancel_follow_request(uuid);
drop function if exists public.accept_follow_request(uuid);
drop function if exists public.decline_follow_request(uuid);

-- Atomically toggle a single emoji reaction for a user.
-- viewer_reactions stores { userId: [emoji, ...] }, an array so users can
-- simultaneously hold a heart AND a custom emoji reaction.
-- Legacy single-string values are transparently migrated on first touch.
-- Pass p_emoji = null to clear ALL reactions for the user.
create or replace function toggle_dream_reaction(
  p_dream_id uuid,
  p_user_id  uuid,
  p_emoji    text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_reactions  jsonb;
  v_counts     jsonb;
  v_user_key   text  := p_user_id::text;
  v_prev_raw   jsonb;
  v_prev_arr   jsonb;
  v_next_arr   jsonb;
  v_was_in     boolean;
  v_e          text;
begin
  select viewer_reactions, reaction_counts
  into   v_reactions, v_counts
  from   public.dreams
  where  id = p_dream_id
  for update;

  if not found then
    raise exception 'Dream not found';
  end if;

  v_reactions := coalesce(v_reactions, '{}'::jsonb);
  v_counts    := coalesce(v_counts,    '{}'::jsonb);
  v_prev_raw  := v_reactions -> v_user_key;

  -- Normalise legacy single-string value to array
  if v_prev_raw is null then
    v_prev_arr := '[]'::jsonb;
  elsif jsonb_typeof(v_prev_raw) = 'string' then
    v_prev_arr := jsonb_build_array(v_prev_raw #>> '{}');
  elsif jsonb_typeof(v_prev_raw) = 'array' then
    v_prev_arr := v_prev_raw;
  else
    v_prev_arr := '[]'::jsonb;
  end if;

  if p_emoji is null or p_emoji = '' then
    -- Clear all reactions for this user
    for v_e in select jsonb_array_elements_text(v_prev_arr) loop
      v_counts := jsonb_set(v_counts, array[v_e],
        to_jsonb(greatest(0, coalesce((v_counts ->> v_e)::int, 0) - 1)));
    end loop;
    v_next_arr := '[]'::jsonb;
  else
    v_was_in := v_prev_arr @> jsonb_build_array(p_emoji);
    if v_was_in then
      -- Remove this emoji from the array
      select coalesce(jsonb_agg(elem), '[]'::jsonb)
      into   v_next_arr
      from   jsonb_array_elements_text(v_prev_arr) as elem
      where  elem != p_emoji;
      v_counts := jsonb_set(v_counts, array[p_emoji],
        to_jsonb(greatest(0, coalesce((v_counts ->> p_emoji)::int, 0) - 1)));
    else
      -- Add this emoji to the array
      v_next_arr := v_prev_arr || jsonb_build_array(p_emoji);
      v_counts   := jsonb_set(v_counts, array[p_emoji],
        to_jsonb(coalesce((v_counts ->> p_emoji)::int, 0) + 1));
    end if;
  end if;

  -- Store: remove key entirely when array is empty
  if jsonb_array_length(v_next_arr) = 0 then
    v_reactions := v_reactions - v_user_key;
  else
    v_reactions := jsonb_set(v_reactions, array[v_user_key], v_next_arr);
  end if;

  update public.dreams
  set    viewer_reactions = v_reactions,
         reaction_counts  = v_counts,
         updated_at       = now()
  where  id = p_dream_id;

  return jsonb_build_object(
    'emoji',   p_emoji,
    'added',   not coalesce(v_was_in, true),
    'changed', true
  );
end;
$$;

-- Request to follow a user. Private targets create a pending request;
-- public targets create a direct follow relationship.
create or replace function request_follow(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requester_id uuid := auth.uid();
  v_target_visibility text;
begin
  if v_requester_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_target_id is null or p_target_id = v_requester_id then
    raise exception 'Invalid target user';
  end if;

  select account_visibility into v_target_visibility
  from public.profiles
  where id = p_target_id;

  if not found then
    raise exception 'Target profile not found';
  end if;

  if coalesce(v_target_visibility, 'private') = 'private' then
    insert into public.follow_requests (requester_id, target_id, status)
    values (v_requester_id, p_target_id, 'pending')
    on conflict (requester_id, target_id)
    do update set status = 'pending', updated_at = now();
    return jsonb_build_object('status', 'pending');
  end if;

  update public.profiles
  set following_ids = array(
        select distinct elem
        from unnest(coalesce(following_ids, '{}'::uuid[]) || p_target_id) as elem
      )
  where id = v_requester_id;

  update public.profiles
  set follower_ids = array(
        select distinct elem
        from unnest(coalesce(follower_ids, '{}'::uuid[]) || v_requester_id) as elem
      )
  where id = p_target_id;

  delete from public.follow_requests
  where requester_id = v_requester_id
    and target_id = p_target_id;

  return jsonb_build_object('status', 'following');
end;
$$;

create or replace function follow_user(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requester_id uuid := auth.uid();
begin
  if v_requester_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_target_id is null or p_target_id = v_requester_id then
    raise exception 'Invalid target user';
  end if;

  update public.profiles
  set following_ids = array(
        select distinct elem
      from unnest(coalesce(following_ids, '{}'::uuid[]) || p_target_id) as elem
      )
  where id = v_requester_id;

  update public.profiles
  set follower_ids = array(
        select distinct elem
        from unnest(coalesce(follower_ids, '{}'::uuid[]) || v_requester_id) as elem
      )
  where id = p_target_id;

  delete from public.follow_requests
  where requester_id = v_requester_id
    and target_id = p_target_id;

  return jsonb_build_object('status', 'following');
end;
$$;

create or replace function unfollow_user(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requester_id uuid := auth.uid();
begin
  if v_requester_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_target_id is null or p_target_id = v_requester_id then
    raise exception 'Invalid target user';
  end if;

  update public.profiles
  set following_ids = array_remove(coalesce(following_ids, '{}'::uuid[]), p_target_id)
  where id = v_requester_id;

  update public.profiles
  set follower_ids = array_remove(coalesce(follower_ids, '{}'::uuid[]), v_requester_id)
  where id = p_target_id;

  delete from public.follow_requests
  where requester_id = v_requester_id
    and target_id = p_target_id;

  return jsonb_build_object('status', 'unfollowed');
end;
$$;

create or replace function cancel_follow_request(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requester_id uuid := auth.uid();
begin
  if v_requester_id is null then
    raise exception 'Not authenticated';
  end if;

  update public.follow_requests
  set status = 'cancelled', updated_at = now()
  where requester_id = v_requester_id
    and target_id = p_target_id
    and status = 'pending';

  return jsonb_build_object('status', 'cancelled');
end;
$$;

create or replace function accept_follow_request(p_requester_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_id uuid := auth.uid();
begin
  if v_target_id is null then
    raise exception 'Not authenticated';
  end if;

  update public.follow_requests
  set status = 'accepted', updated_at = now()
  where requester_id = p_requester_id
    and target_id = v_target_id
    and status = 'pending';

  if not found then
    return jsonb_build_object('status', 'missing_request');
  end if;

  update public.profiles
  set following_ids = array(
        select distinct elem
        from unnest(coalesce(following_ids, '{}'::uuid[]) || v_target_id) as elem
      )
  where id = p_requester_id;

  update public.profiles
  set follower_ids = array(
        select distinct elem
      from unnest(coalesce(follower_ids, '{}'::uuid[]) || p_requester_id) as elem
      )
  where id = v_target_id;

  return jsonb_build_object('status', 'accepted');
end;
$$;

create or replace function decline_follow_request(p_requester_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_id uuid := auth.uid();
begin
  if v_target_id is null then
    raise exception 'Not authenticated';
  end if;

  update public.follow_requests
  set status = 'declined', updated_at = now()
  where requester_id = p_requester_id
    and target_id = v_target_id
    and status = 'pending';

  return jsonb_build_object('status', 'declined');
end;
$$;

-- Atomically toggle a comment heart
create or replace function toggle_comment_heart(
  p_comment_id uuid,
  p_user_id    uuid
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_hearts      uuid[];
  v_count       int;
  v_already     boolean;
  v_added       boolean;
begin
  select heart_user_ids, heart_count
  into   v_hearts, v_count
  from   public.comments
  where  id = p_comment_id
  for update;

  if not found then
    raise exception 'Comment not found';
  end if;

  v_hearts  := coalesce(v_hearts, '{}');
  v_count   := coalesce(v_count, 0);
  v_already := p_user_id = any(v_hearts);

  if v_already then
    v_hearts := array_remove(v_hearts, p_user_id);
    v_count  := greatest(0, v_count - 1);
    v_added  := false;
  else
    v_hearts := array_append(v_hearts, p_user_id);
    v_count  := v_count + 1;
    v_added  := true;
  end if;

  update public.comments
  set    heart_user_ids = v_hearts,
         heart_count    = v_count,
         updated_at     = now()
  where  id = p_comment_id;

  return jsonb_build_object('added', v_added, 'heartCount', v_count);
end;
$$;

-- Atomically check and increment AI usage quota
create or replace function check_and_increment_ai_quota(
  p_user_id    uuid,
  p_month_year text,
  p_free_limit int default 1,
  p_premium_limit int default 30
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_usage         jsonb;
  v_tier          text;
  v_stored_month  text;
  v_monthly_count int;
  v_credits       int;
  v_is_new_month  boolean;
  v_premium_limit int;
begin
  select ai_usage, coalesce(subscription->>'tier', 'free')
  into   v_usage, v_tier
  from   public.profiles
  where  id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'no_user');
  end if;

  v_usage        := coalesce(v_usage, '{}'::jsonb);
  v_stored_month := coalesce(v_usage->>'monthYear', '');
  v_is_new_month := v_stored_month != p_month_year;
  v_monthly_count:= case when v_is_new_month then 0
                         else coalesce((v_usage->>'monthlyCount')::int, 0) end;
  v_credits      := coalesce((v_usage->>'creditBalance')::int, 0);
  v_premium_limit:= greatest(0, coalesce(p_premium_limit, 30));

  if v_tier = 'premium' then
    if v_monthly_count >= v_premium_limit then
      if v_credits <= 0 then
        return jsonb_build_object('allowed', false, 'tier', 'premium',
                                  'remainingFree', 0, 'creditBalance', 0);
      end if;
      update public.profiles
      set    ai_usage = v_usage
                     || jsonb_build_object('monthYear', p_month_year,
                                           'monthlyCount', v_monthly_count,
                                           'creditBalance', v_credits - 1)
      where  id = p_user_id;
      return jsonb_build_object('allowed', true, 'usedCredit', true, 'tier', 'premium',
                                'remainingFree', 0, 'creditBalance', v_credits - 1);
    end if;

    update public.profiles
    set    ai_usage = v_usage
                   || jsonb_build_object('monthYear', p_month_year,
                                         'monthlyCount', v_monthly_count + 1,
                                         'creditBalance', v_credits)
    where  id = p_user_id;
    return jsonb_build_object('allowed', true, 'tier', 'premium',
                              'remainingFree', v_premium_limit - v_monthly_count - 1,
                              'creditBalance', v_credits);
  end if;

  -- Free tier
  if v_monthly_count >= p_free_limit then
    if v_credits <= 0 then
      return jsonb_build_object('allowed', false, 'tier', 'free',
                                'remainingFree', 0, 'creditBalance', 0);
    end if;
    update public.profiles
    set    ai_usage = v_usage
                   || jsonb_build_object('monthYear', p_month_year,
                                         'monthlyCount', v_monthly_count,
                                         'creditBalance', v_credits - 1)
    where  id = p_user_id;
    return jsonb_build_object('allowed', true, 'usedCredit', true, 'tier', 'free',
                              'remainingFree', 0, 'creditBalance', v_credits - 1);
  end if;

  update public.profiles
  set    ai_usage = v_usage
                 || jsonb_build_object('monthYear', p_month_year,
                                       'monthlyCount', v_monthly_count + 1,
                                       'creditBalance', v_credits)
  where  id = p_user_id;

  return jsonb_build_object('allowed', true, 'tier', 'free',
                            'remainingFree', p_free_limit - v_monthly_count - 1,
                            'creditBalance', v_credits);
end;
$$;

-- ============================================================
-- REALTIME: enable on tables that need live updates
-- (Run these in Supabase Dashboard → Database → Replication)
-- alter publication supabase_realtime add table public.dreams;
-- alter publication supabase_realtime add table public.comments;
-- alter publication supabase_realtime add table public.activity;
-- alter publication supabase_realtime add table public.profiles;

-- ============================================================
-- STORAGE: avatars bucket
-- Create this bucket manually in Supabase Dashboard → Storage,
-- then run the RLS policies below in the SQL editor.
--
-- Bucket name : avatars
-- Public      : true
-- Max size    : 2097152  (2 MB)
-- Allowed MIME: image/jpeg, image/webp, image/png
-- ============================================================

-- Allow authenticated users to upload/replace their own avatar.
-- Files are stored at {userId}/avatar.jpg
drop policy if exists "Users can upload own avatar" on storage.objects;
create policy "Users can upload own avatar"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and auth.uid()::text = (storage.foldername(name))[1]
);

drop policy if exists "Users can update own avatar" on storage.objects;
create policy "Users can update own avatar"
on storage.objects for update
to authenticated
using (
  bucket_id = 'avatars'
  and auth.uid()::text = (storage.foldername(name))[1]
);

drop policy if exists "Users can delete own avatar" on storage.objects;
create policy "Users can delete own avatar"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'avatars'
  and auth.uid()::text = (storage.foldername(name))[1]
);

-- Public read for all avatar images (bucket is public, but belt-and-suspenders)
drop policy if exists "Public avatar read" on storage.objects;
create policy "Public avatar read"
on storage.objects for select
using ( bucket_id = 'avatars' );
-- ============================================================
