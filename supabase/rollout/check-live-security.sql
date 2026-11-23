-- Read only: changes nothing.
--
-- What the live database has, for the security review of 11/23/2026. The
-- database fixes from that review get written against this rather than
-- schema.sql, which no longer matches the live functions (the app calls
-- follow_user with target_id; schema.sql names it p_target_id).
--
-- Run it in the Supabase SQL editor, then download the result as CSV and
-- hand it over. One result, four kinds of rows:
--   function          every function in public, with its full body
--   policy            every row rule on public and storage tables
--   trigger           every trigger on public tables
--   readable columns  which columns signed-out (anon) and signed-in
--                     (authenticated) callers may read on the main tables

select 'function' as kind,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name,
       pg_get_functiondef(p.oid) as detail
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'

union all

select 'policy',
       schemaname || '.' || tablename || ': ' || policyname,
       cmd || ' for ' || array_to_string(roles, ', ')
         || E'\nusing: ' || coalesce(qual, '(none)')
         || E'\ncheck: ' || coalesce(with_check, '(none)')
from pg_policies
where schemaname in ('public', 'storage')

union all

select 'trigger',
       event_object_table || ': ' || trigger_name,
       action_timing || ' ' || event_manipulation || ' ' || action_statement
from information_schema.triggers
where trigger_schema = 'public'

union all

select 'readable columns',
       grantee || ' on ' || table_name,
       string_agg(column_name::text, ', ' order by column_name::text)
from information_schema.column_privileges
where table_schema = 'public'
  and privilege_type = 'SELECT'
  and grantee in ('anon', 'authenticated')
  and table_name in ('profiles', 'dreams', 'comments', 'activity', 'follow_requests')
group by grantee, table_name

order by 1, 2;
