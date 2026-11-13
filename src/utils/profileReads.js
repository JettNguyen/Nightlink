import { supabase } from '../supabase';

/**
 * Reading profiles.
 *
 * Other people's profiles: only these columns, which are what the app shows
 * about someone and what it needs to decide who sees which dream. From step 3
 * of the profile privacy rollout (supabase/rollout) they're the only columns
 * anyone signed in can read, so select('*') or any other column fails.
 *
 * Your own profile: fetchOwnProfile, which has all of it (settings, plan,
 * credits, push tokens), through my_profile().
 */
export const PUBLIC_PROFILE_COLUMNS = 'id, display_name, username, normalized_username, photo_url, avatar_icon, '
  + 'avatar_background, avatar_color, account_visibility, following_ids, follower_ids, bio, tier';

// Step 1 of the rollout adds bio and tier. Before it, the same information
// is in settings and subscription.
const COLUMNS_BEFORE_STEP_1 = PUBLIC_PROFILE_COLUMNS.replace('bio, tier', 'settings, subscription');

const isMissingColumn = (error) => error?.code === '42703';
const isMissingFunction = (error) => (
  error?.code === 'PGRST202' || error?.code === '42883' || /could not find the function/i.test(error?.message || '')
);

/**
 * Other people's profiles. `query` gets the columns and returns the query:
 *   readPublicProfiles((columns) => supabase.from('profiles').select(columns).in('id', ids))
 */
export const readPublicProfiles = async (query) => {
  const result = await query(PUBLIC_PROFILE_COLUMNS);
  if (isMissingColumn(result?.error)) return query(COLUMNS_BEFORE_STEP_1);
  return result;
};

/**
 * Your own whole row, or null when it can't be read. Code that changes part of
 * settings has to stop on null: writing back only the part it changed would
 * wipe the rest.
 */
export const fetchOwnProfile = async (uid) => {
  const { data, error } = await supabase.rpc('my_profile');
  if (!error) return (Array.isArray(data) ? data[0] : data) ?? null;
  if (!uid || !isMissingFunction(error)) return null;
  // Before step 1 of the rollout.
  const fallback = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();
  return fallback.error ? null : fallback.data ?? null;
};

/** Your own dream memory: { dream_memory, dream_memory_updated_at }, or null when it can't be read. */
export const fetchOwnDreamMemory = async (uid) => {
  const { data, error } = await supabase.rpc('my_dream_memory');
  if (!error) return (Array.isArray(data) ? data[0] : data) ?? { dream_memory: null, dream_memory_updated_at: null };
  if (!uid || !isMissingFunction(error)) return null;
  const fallback = await supabase.from('profiles').select('dream_memory, dream_memory_updated_at').eq('id', uid).maybeSingle();
  return fallback.error ? null : fallback.data ?? null;
};
