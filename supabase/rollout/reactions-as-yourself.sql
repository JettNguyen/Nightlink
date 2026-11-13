-- ============================================================================
-- Reactions and comment hearts, only as yourself
-- ============================================================================
--
-- Run in Supabase's SQL editor, once. It doesn't need the profile privacy
-- steps and they don't touch what it changes, so it can run before, between
-- or after steps 1 to 3. The sooner the better: until it runs, anyone with
-- the website's public key can react to a dream or heart a comment in
-- someone else's name, or take theirs away. Running it twice changes nothing
-- more.
--
-- Safe for Nightlink 1.3.2 from the App Store (bc21746), the website and the
-- next app version. All of them send the signed-in person's own id
-- (src/services/ReactionService.js, unchanged since 1.3.2).
--
-- What it does
--
-- toggle_dream_reaction(p_dream_id, p_user_id, p_emoji) and
-- toggle_comment_heart(p_comment_id, p_user_id) run with the database's own
-- rights, and they used p_user_id as given. Now:
--
-- 1. They act only as the person signed in (auth.uid()). Any other p_user_id
--    is refused with an error and changes nothing. p_user_id stays, with the
--    same name, because 1.3.2 sends it and PostgREST finds a function by the
--    names of its parameters.
--
-- 2. Someone signed out is refused, and can no longer call either function.
--
-- 3. Both get a fixed search_path, like the rollout's other functions.
--
-- Otherwise the bodies are the ones in schema.sql. Before changing anything it
-- checks that the functions and the columns they use are what those bodies
-- expect, and stops with nothing changed if they aren't. Fold this into
-- schema.sql along with the profile privacy files after step 3.
-- ============================================================================

begin;

do $$
declare
  v_problems text := '';
  r record;
begin
  -- The columns the two bodies read and write.
  for r in
    select need.table_name, need.column_name, need.type_name
    from (values
      ('dreams', 'viewer_reactions', 'jsonb'),
      ('dreams', 'reaction_counts', 'jsonb'),
      ('dreams', 'updated_at', 'timestamptz'),
      ('comments', 'heart_user_ids', '_uuid'),
      ('comments', 'heart_count', 'int4'),
      ('comments', 'updated_at', 'timestamptz')
    ) as need (table_name, column_name, type_name)
    where not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = need.table_name
        and c.column_name = need.column_name and c.udt_name = need.type_name
    )
  loop
    v_problems := v_problems || format(E'\n  no %s.%s of type %s', r.table_name, r.column_name, r.type_name);
  end loop;

  -- The functions as the apps call them, and no others by those names, which
  -- would stay open or leave PostgREST unsure which one to call.
  for r in
    select p.proname::text as name, pg_get_function_identity_arguments(p.oid) as args,
           pg_get_function_result(p.oid) as result
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('toggle_dream_reaction', 'toggle_comment_heart')
  loop
    if (r.name, r.args) not in (
         ('toggle_dream_reaction', 'p_dream_id uuid, p_user_id uuid, p_emoji text'),
         ('toggle_comment_heart', 'p_comment_id uuid, p_user_id uuid'))
       or r.result <> 'jsonb' then
      v_problems := v_problems || format(E'\n  %s(%s) returning %s', r.name, r.args, r.result);
    end if;
  end loop;

  if v_problems <> '' then
    raise exception 'Nothing was changed. The database isn''t what this file expects:%', v_problems
      using hint = 'Compare those with supabase/schema.sql and fix this file before running it again.';
  end if;
end $$;

-- Atomically toggle a single emoji reaction for the signed-in user.
-- viewer_reactions stores { userId: [emoji, ...] }, an array so users can
-- simultaneously hold a heart AND a custom emoji reaction.
-- Legacy single-string values are transparently migrated on first touch.
-- Pass p_emoji = null to clear ALL reactions for the user.
create or replace function public.toggle_dream_reaction(
  p_dream_id uuid,
  p_user_id  uuid,
  p_emoji    text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid  := auth.uid();
  v_reactions  jsonb;
  v_counts     jsonb;
  v_user_key   text;
  v_prev_raw   jsonb;
  v_prev_arr   jsonb;
  v_next_arr   jsonb;
  v_was_in     boolean;
  v_e          text;
begin
  if v_uid is null then
    raise exception 'Sign in to react to a dream' using errcode = '42501';
  end if;
  if p_user_id is distinct from v_uid then
    raise exception 'You can only react as yourself' using errcode = '42501';
  end if;
  v_user_key := v_uid::text;

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

  -- Normalize legacy single-string value to array
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

-- Atomically toggle a comment heart for the signed-in user.
create or replace function public.toggle_comment_heart(
  p_comment_id uuid,
  p_user_id    uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_hearts      uuid[];
  v_count       int;
  v_already     boolean;
  v_added       boolean;
begin
  if v_uid is null then
    raise exception 'Sign in to heart a comment' using errcode = '42501';
  end if;
  if p_user_id is distinct from v_uid then
    raise exception 'You can only heart a comment as yourself' using errcode = '42501';
  end if;

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
  v_already := v_uid = any(v_hearts);

  if v_already then
    v_hearts := array_remove(v_hearts, v_uid);
    v_count  := greatest(0, v_count - 1);
    v_added  := false;
  else
    v_hearts := array_append(v_hearts, v_uid);
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

revoke execute on function public.toggle_dream_reaction(uuid, uuid, text), public.toggle_comment_heart(uuid, uuid)
  from public, anon;
grant execute on function public.toggle_dream_reaction(uuid, uuid, text), public.toggle_comment_heart(uuid, uuid)
  to authenticated;

commit;
