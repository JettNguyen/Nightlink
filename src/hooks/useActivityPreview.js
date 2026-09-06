import { useCallback, useEffect, useMemo, useState } from 'react';
import useRefreshSignal from './useRefreshSignal';
import { supabase } from '../supabase';
import { mapProfile, mapActivity, mapDream } from '../utils/mappers';
import { markActivityEntriesRead } from '../services/ActivityService';

const DEFAULT_INBOX_LIMIT = 25;
const MAX_FOLLOWING_RESULTS = 20;

const toMillis = (value) => {
  if (!value) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : new Date(value).getTime() || 0;
  }
  return 0;
};

const canViewerSeeDream = (entry, ownerProfile, viewerId) => {
  if (!entry) return false;
  const excluded = Array.isArray(entry.excludedViewerIds) && entry.excludedViewerIds.includes(viewerId);
  if (excluded) return false;
  if (entry.userId === viewerId) return true;
  const vis = entry.visibility || 'private';
  if (vis === 'public' || vis === 'anonymous') return true;
  if (vis === 'followers') {
    return viewerId ? (ownerProfile?.followerIds || []).includes(viewerId) : false;
  }
  if (vis === 'mutuals') {
    if (!viewerId) return false;
    return (ownerProfile?.followerIds || []).includes(viewerId)
      && (ownerProfile?.followingIds || []).includes(viewerId);
  }
  return false;
};

export default function useActivityPreview(viewerId, options = {}) {
  const inboxLimit = options.inboxLimit ?? DEFAULT_INBOX_LIMIT;
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewerProfile, setViewerProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(Boolean(viewerId));
  const [inboxEntries, setInboxEntries] = useState([]);
  const [inboxLoading, setInboxLoading] = useState(Boolean(viewerId));
  const [inboxError, setInboxError] = useState('');
  const [followingUpdates, setFollowingUpdates] = useState([]);
  const [followingLoading, setFollowingLoading] = useState(Boolean(viewerId));

  const feedSeenAt = useMemo(() => (
    Math.max(toMillis(viewerProfile?.feedSeenAtMs), 0)
  ), [viewerProfile?.feedSeenAtMs]);

  useEffect(() => {
    if (!viewerId) {
      setViewerProfile(null);
      setProfileLoading(false);
      return;
    }
    setProfileLoading(true);

    supabase.from('profiles').select('*').eq('id', viewerId).single()
      .then(({ data }) => {
        setViewerProfile(data ? mapProfile(data) : null);
        setProfileLoading(false);
      });

    const channel = supabase
      .channel(`profile:${viewerId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${viewerId}` },
        (payload) => setViewerProfile(mapProfile(payload.new)))
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [viewerId, refreshKey]);

  useEffect(() => {
    if (!viewerId) {
      setInboxEntries([]);
      setInboxLoading(false);
      setInboxError('');
      return;
    }
    setInboxLoading(true);
    setInboxError('');

    const fetchInbox = async () => {
      const { data, error } = await supabase
        .from('activity')
        .select('*')
        .eq('target_user_id', viewerId)
        .order('created_at', { ascending: false })
        .limit(inboxLimit);
      if (error) {
        setInboxError('Could not load activity right now.');
      } else {
        setInboxEntries((data || []).map(mapActivity));
      }
      setInboxLoading(false);
    };

    fetchInbox();

    const channel = supabase
      .channel(`activity:${viewerId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activity', filter: `target_user_id=eq.${viewerId}` },
        () => fetchInbox())
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [viewerId, inboxLimit, refreshKey]);

  useEffect(() => {
    const followingIds = viewerProfile?.followingIds || [];
    const followingSince = viewerProfile?.followingSince || {};
    // For follows that pre-date this feature, fall back to 14 days ago.
    const fallbackCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    if (!viewerId || !followingIds.length) {
      setFollowingUpdates([]);
      setFollowingLoading(false);
      return;
    }
    setFollowingLoading(true);
    let cancelled = false;

    const fetchFollowingFeed = async () => {
      const { data: dreamsData } = await supabase
        .from('dreams')
        .select('*, profiles!user_id(following_ids, follower_ids)')
        .in('user_id', followingIds)
        .in('visibility', ['public', 'followers', 'mutuals'])
        .order('created_at', { ascending: false })
        .limit(50);

      if (cancelled) return;

      const entries = (dreamsData || [])
        .map((row) => {
          const ownerProfile = row.profiles ? mapProfile({ ...row.profiles, id: row.user_id }) : null;
          const dream = mapDream(row);
          return { dream, ownerProfile };
        })
        .filter(({ dream, ownerProfile }) => {
          if (!canViewerSeeDream(dream, ownerProfile, viewerId)) return false;
          const cutoff = followingSince[dream.userId] ?? fallbackCutoff;
          const dreamTime = dream.createdAt?.getTime() ?? 0;
          return dreamTime >= cutoff;
        })
        .sort((a, b) => {
          const aTime = (a.dream.updatedAt || a.dream.createdAt)?.getTime?.() || 0;
          const bTime = (b.dream.updatedAt || b.dream.createdAt)?.getTime?.() || 0;
          return bTime - aTime;
        })
        .slice(0, MAX_FOLLOWING_RESULTS)
        .map(({ dream, ownerProfile }) => ({
          ...dream,
          ownerProfile,
          reactionCounts: dream.reactionCounts || {},
          viewerReaction: dream.viewerReactions?.[viewerId] || null,
        }));

      setFollowingUpdates(entries);
      setFollowingLoading(false);
    };

    fetchFollowingFeed();

    // Server-side filter when following ≤50 users keeps the subscription tight.
    // For larger lists we subscribe unfiltered but debounce + client-filter to
    // avoid a full re-fetch on every dream write in the database.
    const realtimeFilter = followingIds.length <= 50
      ? { filter: `user_id=in.(${followingIds.join(',')})` }
      : {};

    let debounceTimer = null;
    const handleDreamChange = (payload) => {
      if (realtimeFilter.filter) {
        // Server already filtered to followed users, so fire immediately.
        fetchFollowingFeed();
        return;
      }
      // Unfiltered subscription: discard events from users we don't follow.
      const changedUserId = payload?.new?.user_id || payload?.old?.user_id;
      if (changedUserId && !followingIds.includes(changedUserId)) return;
      // Debounce bursts (e.g. bulk reaction updates) to a single re-fetch.
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { debounceTimer = null; fetchFollowingFeed(); }, 2000);
    };

    const channel = supabase
      .channel(`following-feed:${viewerId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dreams', ...realtimeFilter },
        handleDreamChange)
      .subscribe();

    return () => {
      clearTimeout(debounceTimer);
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [viewerId, viewerProfile?.followingIds]);

  const unreadInboxCount = useMemo(() => (
    inboxEntries.filter((entry) => entry?.read === false).length
  ), [inboxEntries]);

  const markAllInboxRead = useCallback(async () => {
    const unreadIds = inboxEntries.filter((e) => e?.read === false).map((e) => e.id);
    if (!unreadIds.length) return;
    setInboxEntries((prev) => prev.map((e) => ({ ...e, read: true })));
    await markActivityEntriesRead(viewerId, unreadIds);
  }, [inboxEntries, viewerId]);

  const hasActivity = useMemo(() => (
    inboxEntries.length > 0 || followingUpdates.length > 0
  ), [inboxEntries.length, followingUpdates.length]);

  const latestFollowingTimestamp = useMemo(() => (
    followingUpdates.reduce((latest, entry) => {
      const time = (entry.updatedAt || entry.createdAt)?.getTime?.() || 0;
      return time > latest ? time : latest;
    }, 0)
  ), [followingUpdates]);

  useRefreshSignal(useCallback(() => setRefreshKey((n) => n + 1), []));

  return {
    viewerProfile,
    profileLoading,
    inboxEntries,
    inboxLoading,
    inboxError,
    followingUpdates,
    followingLoading,
    hasActivity,
    unreadActivityCount: unreadInboxCount,
    hasUnreadActivity: unreadInboxCount > 0,
    latestFollowingTimestamp,
    feedSeenAt,
    markAllInboxRead,
  };
}
