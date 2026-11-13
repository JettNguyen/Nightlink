-- The parts of a Supabase database that schema.sql and the rollout files lean
-- on, for a throwaway local Postgres. Run by scripts/test-profile-privacy.mjs,
-- never against the live project.
--
-- What it copies from Supabase:
-- - the anon, authenticated and service_role roles. PostgREST switches to one
--   of them for every request; service_role skips row level security.
-- - auth.uid(), auth.role() and auth.jwt(), which read the request.jwt.claims
--   setting PostgREST fills in from the caller's token.
-- - the default grants on the public schema: every role gets every table and
--   function, so row level security and column grants are what keep data in.
-- - enough of auth.users and storage.objects for schema.sql to run.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;

create schema auth;
create table auth.users (
  id         uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema storage;
create table storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text,
  name      text,
  owner     uuid
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects to anon, authenticated, service_role;
