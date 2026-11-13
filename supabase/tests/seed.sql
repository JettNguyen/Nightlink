-- Three made-up people for the profile privacy tests. Every private column holds
-- something, so a test can tell "hidden" from "empty".
--
-- Sam   6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61  Pro from the App Store (1.3.2 wrote it)
-- Dana  f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42  Pro from a comp before plans had sources
-- Ellen 0c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6  free, follows Sam
-- Mike  9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d  just signed up, no profile yet

insert into auth.users (id, email) values
  ('6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61', 'sam@example.com'),
  ('f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42', 'dana@example.com'),
  ('0c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6', 'ellen@example.com'),
  ('9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', 'mike@example.com');

insert into public.profiles (
  id, email, display_name, username, normalized_username, account_visibility,
  settings, subscription, ai_usage, fcm_tokens, following_ids, follower_ids,
  dream_memory, dream_memory_updated_at
) values (
  '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61', 'sam@example.com', 'Sam', 'Sam', 'sam', 'public',
  '{"bio": "Lucid most nights.", "accountVisibility": "public", "blockedUserIds": ["f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42"],
    "aiPromptCustom": "Be gentle.", "safetyReports": [{"targetId": "x", "reason": "spam"}], "termsVersion": "v3"}',
  '{"tier": "premium", "provider": "revenuecat", "expiresAt": "2099-01-01T00:00:00Z", "updatedAt": "2026-11-01T00:00:00Z"}',
  '{"monthYear": "2026-11", "monthlyCount": 3, "creditBalance": 5}',
  '{apns-token-sam}', '{}', '{0c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6}',
  'Sam keeps dreaming about a red door.', '2026-11-01T00:00:00Z'
), (
  'f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42', 'dana@example.com', 'Dana', 'dana', 'dana', 'private',
  '{"bio": "Night owl.", "safetyReports": [{"targetId": "y", "reason": "harassment", "details": "about Sam"}]}',
  '{"tier": "premium"}',
  '{"monthYear": "2026-11", "monthlyCount": 1, "creditBalance": 0}',
  '{apns-token-dana}', '{}', '{}',
  'Dana dreams of falling.', '2026-11-02T00:00:00Z'
), (
  '0c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6', 'ellen@example.com', 'Ellen', 'ellen', 'ellen', 'private',
  '{}', '{"tier": "free"}', '{"monthYear": "", "monthlyCount": 0, "creditBalance": 0}',
  '{}', '{6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61}', '{}',
  null, null
);

insert into public.dreams (id, user_id, title, content, visibility) values
  ('11111111-1111-4111-8111-111111111111', '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61', 'Red door', 'A red door again.', 'followers'),
  ('22222222-2222-4222-8222-222222222222', '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61', 'Open sky', 'Flying.', 'public'),
  ('33333333-3333-4333-8333-333333333333', 'f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42', 'Falling', 'Falling again.', 'private');
