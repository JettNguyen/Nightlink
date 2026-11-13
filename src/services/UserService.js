import { supabase } from '../supabase';
import { mapProfile } from '../utils/mappers';
import { readPublicProfiles } from '../utils/profileReads';

// Cap prevents unbounded memory growth across long sessions.
const MAX_CACHE_SIZE = 200;
const userSummaryCache = new Map();

const normalizeProfile = (row) => {
  if (!row) return null;
  const p = mapProfile(row);
  return {
    id: p.id,
    displayName: p.displayName,
    username: p.username,
    photoURL: p.photoURL,
    avatarIcon: p.avatarIcon,
    avatarBackground: p.avatarBackground,
    avatarColor: p.avatarColor,
    // Drives the Pro badge. Without it an author resolved through this summary
    // has no subscription at all, which is why viewers never saw their own
    // badge: everyone they follow comes from a full profile row, but they do
    // not follow themselves, so their own card fell through to here.
    subscription: p.subscription,
  };
};

export const fetchUserSummaries = async (rawIds = []) => {
  const ids = [...new Set(rawIds.filter((id) => typeof id === 'string' && id.trim().length))];
  if (!ids.length) return {};

  const pending = ids.filter((id) => !userSummaryCache.has(id));
  if (pending.length) {
    try {
      const { data } = await readPublicProfiles((columns) => (
        supabase.from('profiles').select(columns).in('id', pending)
      ));
      (data || []).forEach((row) => {
        userSummaryCache.set(row.id, normalizeProfile(row));
      });
      // Evict oldest entries when over the cap (Map preserves insertion order)
      if (userSummaryCache.size > MAX_CACHE_SIZE) {
        const overflow = userSummaryCache.size - MAX_CACHE_SIZE;
        let evicted = 0;
        for (const key of userSummaryCache.keys()) {
          if (evicted >= overflow) break;
          userSummaryCache.delete(key);
          evicted += 1;
        }
      }
    } catch (error) {
      console.error('Failed to fetch user summaries', error);
    }
  }

  return ids.reduce((acc, id) => {
    if (userSummaryCache.has(id)) acc[id] = userSummaryCache.get(id);
    return acc;
  }, {});
};

export const clearUserSummaryCache = () => {
  userSummaryCache.clear();
};

export const persistFeedSeenTimestamp = async (uid, seenAt = Date.now()) => {
  if (!uid) return false;
  try {
    const { error } = await supabase
      .from('profiles')
      .update({ feed_seen_at_ms: seenAt })
      .eq('id', uid);
    return !error;
  } catch (error) {
    console.error('Failed to persist feed seen timestamp', error);
    return false;
  }
};

export default fetchUserSummaries;
