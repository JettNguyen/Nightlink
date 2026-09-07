import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeart, faPlus, faComment, faEllipsisVertical } from '@fortawesome/free-solid-svg-icons';
import { supabase } from '../supabase';
import { mapDream, mapProfile } from '../utils/mappers';
import { DEFAULT_AVATAR_BACKGROUND, DEFAULT_AVATAR_COLOR } from '../constants/avatarOptions';
import AvatarDisplay from '../components/AvatarDisplay';
import ProBadge from '../components/ProBadge';
import { formatDreamDate } from '../utils/dates';
import { buildProfilePath, buildDreamPath } from '../utils/urlHelpers';
import './Feed.css';
import { FeedSkeleton } from '../components/SkeletonLoader';
import Toast from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import updateDreamReaction from '../services/ReactionService';
import fetchUserSummaries from '../services/UserService';
import { appUserPropType } from '../propTypes';
import useEscapeKey from '../hooks/useEscapeKey';
import useRefreshSignal from '../hooks/useRefreshSignal';
import { triggerLightHaptic, triggerSelectionHaptic, triggerSuccessHaptic, triggerErrorHaptic } from '../utils/haptics';
import { COMMON_EMOJI_REACTIONS, filterEmojiInput } from '../constants/emojiOptions';

const DEFAULT_API_ORIGIN = 'https://www.nightlink.dev';

const resolveAccountEndpoint = () => {
  const configuredEndpoint = (import.meta.env.VITE_ACCOUNT_ENDPOINT || '').trim();
  if (configuredEndpoint) return configuredEndpoint;
  const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || '').trim();
  if (configuredApiBase) return `${configuredApiBase.replace(/\/$/, '')}/api/account`;
  if (typeof window !== 'undefined' && window.location?.origin) return '/api/account';
  return `${DEFAULT_API_ORIGIN}/api/account`;
};

const ACCOUNT_ENDPOINT = resolveAccountEndpoint();

// Engagement + recency score. Higher = shown first in For You feed.
const scoreDream = (dream) => {
  const hoursSince = dream.createdAt
    ? (Date.now() - new Date(dream.createdAt).getTime()) / 3_600_000
    : 9999;
  const recency = 1 / (1 + hoursSince / 72);
  const reactions = Object.values(dream.reactionCounts || {}).reduce((s, v) => s + (v || 0), 0);
  return recency * 10 + reactions * 2 + (dream.commentCount || 0) * 1.5;
};

export default function Feed({ user }) {
  const [activeTab, setActiveTab] = useState('foryou');
  const [followingIds, setFollowingIds] = useState([]);
  const [followingIdsLoaded, setFollowingIdsLoaded] = useState(false);
  const [followingProfiles, setFollowingProfiles] = useState({});
  const [rawDreams, setRawDreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forYouDreams, setForYouDreams] = useState([]);
  const [forYouLoaded, setForYouLoaded] = useState(false);
  const [forYouLoading, setForYouLoading] = useState(false);
  const [reactionState, setReactionState] = useState({});
  const [customReactionTarget, setCustomReactionTarget] = useState(null);
  const [customReactionValue, setCustomReactionValue] = useState('');
  const [userSummaries, setUserSummaries] = useState({});
  const [blockedUserIds, setBlockedUserIds] = useState([]);
  const [hiddenDreamIds, setHiddenDreamIds] = useState([]);
  const [toast, setToast] = useState('');
  const [confirmModal, setConfirmModal] = useState(null);
  const [reportModal, setReportModal] = useState(null);
  const [reportReason, setReportReason] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const [feedMenuOpenDreamId, setFeedMenuOpenDreamId] = useState(null);
  const customEmojiInputRef = useRef(null);
  const userSummariesRef = useRef(userSummaries);
  // viewerSettings only drives persistViewerSafetySettings, so no render dependency
  const viewerSettingsRef = useRef({});
  const navigate = useNavigate();
  const defaultReaction = '💙';
  const viewerId = user?.uid || null;

  useEffect(() => {
    if (!feedMenuOpenDreamId) return undefined;
    const handlePointerDown = (event) => {
      if (!event.target.closest('[data-feed-menu-root="true"]')) setFeedMenuOpenDreamId(null);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setFeedMenuOpenDreamId(null);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [feedMenuOpenDreamId]);

  useEffect(() => {
    if (!user?.uid) {
      setFollowingIds([]);
      setFollowingIdsLoaded(true);
      return;
    }
    supabase.from('profiles').select('following_ids, settings').eq('id', user.uid).single()
      .then(({ data }) => {
        setFollowingIds(data?.following_ids || []);
        const settings = data?.settings || {};
        viewerSettingsRef.current = settings;
        setBlockedUserIds(Array.isArray(settings.blockedUserIds) ? settings.blockedUserIds : []);
        setHiddenDreamIds(Array.isArray(settings.hiddenDreamIds) ? settings.hiddenDreamIds : []);
        setFollowingIdsLoaded(true);
      });
    const channel = supabase
      .channel(`feed-profile:${user.uid}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${user.uid}` },
        (payload) => {
          setFollowingIds(payload.new?.following_ids || []);
          const settings = payload.new?.settings || {};
          viewerSettingsRef.current = settings;
          setBlockedUserIds(Array.isArray(settings.blockedUserIds) ? settings.blockedUserIds : []);
          setHiddenDreamIds(Array.isArray(settings.hiddenDreamIds) ? settings.hiddenDreamIds : []);
        })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [user?.uid]);

  useEffect(() => {
    if (!followingIds.length) {
      setFollowingProfiles({});
      return;
    }
    supabase.from('profiles').select('*').in('id', followingIds)
      .then(({ data }) => {
        const map = {};
        (data || []).forEach((row) => { map[row.id] = mapProfile(row); });
        setFollowingProfiles(map);
      });
  }, [followingIds]);

  useEffect(() => {
    if (!followingIds.length) {
      setRawDreams([]);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    let cancelled = false;
    // Anonymous dreams excluded from Following, because a small following list would reveal
    // the author. They appear in For You only where the pool is large enough.
    const FEED_VISIBILITIES = new Set(['public', 'followers', 'mutuals']);
    const followingSet = new Set(followingIds);

    supabase.from('dreams').select('*')
      .in('user_id', followingIds)
      .in('visibility', [...FEED_VISIBILITIES])
      .order('created_at', { ascending: false })
      .limit(60)
      .then(({ data, error: fetchErr }) => {
        if (cancelled) return;
        if (fetchErr) { setError('Unable to load your following feed right now.'); setLoading(false); return; }
        setRawDreams((data || []).map(mapDream));
        setLoading(false);
      });

    // Server-side filter when following ≤50. Surgical state updates, no full re-fetch.
    const realtimeFilter = followingIds.length <= 50
      ? { filter: `user_id=in.(${followingIds.join(',')})` }
      : {};

    const channel = supabase
      .channel(`feed-dreams:${viewerId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dreams', ...realtimeFilter },
        (payload) => {
          const dream = mapDream(payload.new);
          if (!followingSet.has(dream.userId)) return;
          if (!FEED_VISIBILITIES.has(dream.visibility)) return;
          setRawDreams((prev) => [dream, ...prev]);
        })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'dreams', ...realtimeFilter },
        (payload) => {
          const dream = mapDream(payload.new);
          if (!followingSet.has(dream.userId)) return;
          setRawDreams((prev) => {
            const idx = prev.findIndex((d) => d.id === dream.id);
            if (idx === -1) return FEED_VISIBILITIES.has(dream.visibility) ? [dream, ...prev] : prev;
            if (!FEED_VISIBILITIES.has(dream.visibility)) return prev.filter((d) => d.id !== dream.id);
            const next = [...prev]; next[idx] = dream; return next;
          });
        })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'dreams', ...realtimeFilter },
        (payload) => { setRawDreams((prev) => prev.filter((d) => d.id !== payload.old.id)); })
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [followingIds, viewerId]);

  const fetchForYouDreams = useCallback(async () => {
    if (!viewerId) return;
    setForYouLoading(true);
    try {
      const { data, error: fetchErr } = await supabase
        .from('dreams')
        .select('*')
        .in('visibility', ['public', 'anonymous'])
        .order('created_at', { ascending: false })
        .limit(100);
      if (fetchErr) throw fetchErr;
      const mapped = (data || [])
        .map(mapDream)
        .filter(Boolean)
        .sort((a, b) => scoreDream(b) - scoreDream(a))
        .slice(0, 60);
      setForYouDreams(mapped);
    } catch {
      // show empty state
    } finally {
      setForYouLoaded(true);
      setForYouLoading(false);
    }
  }, [viewerId]);

  useEffect(() => {
    if (!followingIdsLoaded || forYouLoaded) return;
    fetchForYouDreams();
  }, [followingIdsLoaded, forYouLoaded, fetchForYouDreams]);

  // The following feed keeps itself current over realtime; For You is a one-shot
  // ranked query, so that is what a pull needs to re-run.
  useRefreshSignal(fetchForYouDreams);

  const visibleDreams = useMemo(() => {
    if (!rawDreams.length) return [];
    const filtered = rawDreams.filter((dream) => {
      if (!dream) return false;
      if (hiddenDreamIds.includes(dream.id)) return false;
      if (dream.userId && blockedUserIds.includes(dream.userId)) return false;
      const vis = dream.visibility || 'private';
      if (vis === 'private') return dream.userId === viewerId;
      if (viewerId && Array.isArray(dream.excludedViewerIds) && dream.excludedViewerIds.includes(viewerId)) return false;
      if (viewerId && Array.isArray(dream.taggedUserIds) && dream.taggedUserIds.includes(viewerId)) return true;
      if (vis === 'anonymous') return false;
      if (vis === 'public') return true;
      if (!viewerId) return false;
      const authorProfile = dream.userId ? followingProfiles[dream.userId] : null;
      if (vis === 'followers') return (authorProfile?.followerIds || []).includes(viewerId);
      if (vis === 'mutuals') {
        return (authorProfile?.followerIds || []).includes(viewerId)
          && (authorProfile?.followingIds || []).includes(viewerId);
      }
      return false;
    });
    return filtered.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
  }, [rawDreams, followingProfiles, viewerId, blockedUserIds, hiddenDreamIds]);

  const visibleForYouDreams = useMemo(() => {
    if (!forYouDreams.length) return [];
    return forYouDreams.filter((dream) => {
      if (!dream) return false;
      if (hiddenDreamIds.includes(dream.id)) return false;
      if (dream.userId && blockedUserIds.includes(dream.userId)) return false;
      if (viewerId && Array.isArray(dream.excludedViewerIds) && dream.excludedViewerIds.includes(viewerId)) return false;
      return true;
    });
  }, [forYouDreams, hiddenDreamIds, blockedUserIds, viewerId]);

  const allFeedDreams = useMemo(() => {
    const seen = new Set();
    return [...visibleDreams, ...visibleForYouDreams].filter((d) => {
      if (!d?.id || seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
  }, [visibleDreams, visibleForYouDreams]);

  const persistViewerSafetySettings = useCallback(async (nextSettings) => {
    if (!viewerId) return;
    const previous = viewerSettingsRef.current;
    const merged = { ...previous, ...(nextSettings || {}) };
    viewerSettingsRef.current = merged;
    // Supabase returns the failure rather than throwing, so surface it as one.
    // Callers roll their optimistic state back on a rejection.
    const { error: persistError } = await supabase.from('profiles').update({ settings: merged }).eq('id', viewerId);
    if (persistError) {
      viewerSettingsRef.current = previous;
      throw persistError;
    }
  }, [viewerId]);

  const handleHideDream = useCallback(async (event, dreamId) => {
    event.preventDefault(); event.stopPropagation();
    if (!dreamId) return;
    const previousHidden = hiddenDreamIds || [];
    const nextHidden = [...new Set([...previousHidden, dreamId])];
    setHiddenDreamIds(nextHidden);
    try {
      await persistViewerSafetySettings({ hiddenDreamIds: nextHidden });
      void triggerSuccessHaptic();
      setToast('Removed from your feed.');
    } catch {
      setHiddenDreamIds(previousHidden);
      void triggerErrorHaptic();
      setToast('Could not update your feed right now.');
    }
  }, [hiddenDreamIds, persistViewerSafetySettings]);

  const blockAuthor = useCallback(async (authorId) => {
    if (!authorId || !viewerId || authorId === viewerId) return;
    const previousBlocked = blockedUserIds || [];
    const nextBlocked = [...new Set([...previousBlocked, authorId])];
    setBlockedUserIds(nextBlocked);
    try {
      await persistViewerSafetySettings({ blockedUserIds: nextBlocked });
      void triggerSuccessHaptic();
      setToast('User blocked. Their dreams are now hidden from your feed.');
    } catch {
      setBlockedUserIds(previousBlocked);
      void triggerErrorHaptic();
      setToast('Could not block this user right now.');
    }
  }, [blockedUserIds, viewerId, persistViewerSafetySettings]);

  // Blocking is a one-tap item in a small overflow menu, so confirm it first.
  const handleBlockAuthor = useCallback((event, authorId, authorLabel) => {
    event.preventDefault(); event.stopPropagation();
    if (!authorId || !viewerId || authorId === viewerId) return;
    setConfirmModal({
      title: 'Block user',
      message: `Block ${authorLabel || 'this dreamer'}? Their dreams disappear from your feed. You can unblock them from their profile.`,
      confirmLabel: 'Block',
      danger: true,
      onConfirm: () => {
        setConfirmModal(null);
        blockAuthor(authorId);
      },
    });
  }, [blockAuthor, viewerId]);

  const submitSafetyReport = useCallback(async ({ targetType, targetId, targetUserId, reason, details }) => {
    if (!viewerId) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const idToken = sessionData?.session?.access_token;
    if (!idToken) throw new Error('Please sign in again before reporting.');
    const response = await fetch(ACCOUNT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ action: 'report_content', uid: viewerId, targetType, targetId, targetUserId: targetUserId || null, reason, details: details || '' }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Could not submit report.');
  }, [viewerId]);

  const handleReportDream = useCallback((event, dream) => {
    event.preventDefault(); event.stopPropagation();
    if (!dream?.id) return;
    setReportReason('');
    setReportModal({ dream });
  }, []);

  const closeReportModal = useCallback(() => {
    setReportModal(null);
    setReportReason('');
  }, []);

  useEscapeKey(closeReportModal, Boolean(reportModal));

  const toggleFeedMenu = useCallback((event, dreamId) => {
    event.preventDefault(); event.stopPropagation();
    void triggerLightHaptic();
    setFeedMenuOpenDreamId((prev) => (prev === dreamId ? null : dreamId));
  }, []);

  const closeFeedMenu = useCallback(() => {
    setFeedMenuOpenDreamId(null);
  }, []);

  const handleSubmitReport = useCallback(async () => {
    if (!reportModal?.dream || !reportReason.trim()) return;
    setReportBusy(true);
    try {
      await submitSafetyReport({
        targetType: 'dream',
        targetId: reportModal.dream.id,
        targetUserId: reportModal.dream.userId,
        reason: reportReason.trim(),
        details: `Reported from feed at ${new Date().toISOString()}`,
      });
      setReportModal(null);
      setReportReason('');
      void triggerSuccessHaptic();
      setToast('Report submitted. We review safety reports within 24 hours.');
    } catch (err) {
      setToast(err.message || 'Could not submit report.');
    } finally {
      setReportBusy(false);
    }
  }, [reportModal, reportReason, submitSafetyReport]);

  const handleRemoveOwnDream = useCallback((event, dream) => {
    event.preventDefault(); event.stopPropagation();
    if (!dream?.id || dream.userId !== viewerId) return;
    setConfirmModal({
      title: 'Remove dream',
      message: 'Remove this dream? This cannot be undone.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        setRawDreams((prev) => prev.filter((entry) => entry.id !== dream.id));
        setForYouDreams((prev) => prev.filter((entry) => entry.id !== dream.id));
        try {
          const { error: removeError } = await supabase.from('dreams').delete().eq('id', dream.id);
          if (removeError) throw removeError;
        } catch { setToast('Could not remove this dream right now.'); }
      },
    });
  }, [viewerId]);

  useEffect(() => {
    setReactionState((prev) => {
      const visibleIds = new Set(allFeedDreams.map((d) => d?.id).filter(Boolean));
      const pruned = Object.fromEntries(Object.entries(prev).filter(([id]) => visibleIds.has(id)));
      let changed = Object.keys(pruned).length !== Object.keys(prev).length;
      const next = { ...pruned };
      allFeedDreams.forEach((dream) => {
        if (!dream?.id || next[dream.id]) return;
        changed = true;
        const counts = dream.reactionCounts || {};
        const raw = dream.viewerReactions?.[viewerId] ?? [];
        const viewerReactions = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        next[dream.id] = { counts, viewerReactions };
      });
      return changed ? next : prev;
    });
  }, [allFeedDreams, viewerId]);

  useEffect(() => {
    if (!customReactionTarget) return;
    if (!allFeedDreams.some((dream) => dream.id === customReactionTarget)) {
      setCustomReactionTarget(null); setCustomReactionValue('');
    }
  }, [customReactionTarget, allFeedDreams]);

  useEffect(() => {
    if (!customReactionTarget) { customEmojiInputRef.current = null; return; }
    const raf = requestAnimationFrame(() => {
      const input = customEmojiInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange(end, end);
      if (typeof navigator !== 'undefined' && navigator.virtualKeyboard?.show) {
        // Best-effort only: the API is unavailable on iOS and can throw when the
        // page has not opted into virtualkeyboard overlay mode.
        try { navigator.virtualKeyboard.show(); } catch { /* keyboard stays closed */ }
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [customReactionTarget]);

  const handleReactionSelection = useCallback(async (dream, emoji) => {
    if (!viewerId) { setToast('Sign in to react to dreams.'); return; }
    const currentState = reactionState[dream.id];
    const prevReactions = currentState?.viewerReactions || [];
    const isRemoving = emoji === null || prevReactions.includes(emoji);
    void triggerLightHaptic();
    setReactionState((prev) => {
      const counts = { ...(prev[dream.id]?.counts || dream.reactionCounts || {}) };
      let nextReactions;
      if (emoji === null) {
        prevReactions.forEach((e) => { counts[e] = Math.max((counts[e] || 1) - 1, 0); });
        nextReactions = [];
      } else if (isRemoving) {
        counts[emoji] = Math.max((counts[emoji] || 1) - 1, 0);
        nextReactions = prevReactions.filter((e) => e !== emoji);
      } else {
        counts[emoji] = (counts[emoji] || 0) + 1;
        nextReactions = [...prevReactions, emoji];
      }
      return { ...prev, [dream.id]: { counts, viewerReactions: nextReactions } };
    });
    try {
      await updateDreamReaction({
        dreamId: dream.id,
        dreamOwnerId: dream.userId,
        dreamTitleSnapshot: dream.title || dream.aiTitle || 'Dream',
        userId: viewerId,
        emoji: emoji ?? null,
        actorDisplayName: user?.displayName || user?.email || 'Nightlink dreamer',
        actorUsername: user?.username || null,
      });
    } catch (err) {
      console.error('Failed to update dream reaction', err);
      void triggerErrorHaptic();
      setReactionState((prev) => ({
        ...prev,
        [dream.id]: { counts: currentState?.counts || dream.reactionCounts || {}, viewerReactions: prevReactions },
      }));
    }
  }, [reactionState, user, viewerId]);

  const closeCustomReactionPicker = () => {
    setCustomReactionTarget(null);
    setCustomReactionValue('');
  };

  const handleReactionClick = (event, dream, emoji) => {
    event.stopPropagation();
    event.preventDefault();
    closeCustomReactionPicker();
    handleReactionSelection(dream, emoji);
  };

  const openCustomReactionPicker = (event, dream) => {
    event.stopPropagation();
    event.preventDefault();
    setCustomReactionTarget(dream.id);
    setCustomReactionValue('');
  };

  const handleCustomEmojiChange = (value) => setCustomReactionValue(filterEmojiInput(value));
  const handleCustomReactionSubmit = (event, dream) => {
    event.preventDefault(); event.stopPropagation();
    const emoji = filterEmojiInput(customReactionValue);
    if (!emoji) return;
    handleReactionSelection(dream, emoji);
    closeCustomReactionPicker();
  };

  useEffect(() => {
    userSummariesRef.current = userSummaries;
  }, [userSummaries]);

  useEffect(() => {
    const reactionIds = allFeedDreams.flatMap((dream) => Object.keys(dream.viewerReactions || {}));
    const forYouAuthorIds = forYouDreams.map((d) => d.userId).filter(Boolean);
    const allIds = [...reactionIds, ...forYouAuthorIds];
    if (!allIds.length) return;
    const missing = [...new Set(allIds)].filter((id) => !userSummariesRef.current[id]);
    if (!missing.length) return;
    fetchUserSummaries(missing).then((fetched) => {
      if (fetched && Object.keys(fetched).length) setUserSummaries((prev) => ({ ...prev, ...fetched }));
    }).catch(() => {});
  }, [allFeedDreams, forYouDreams]);

  const renderDreamCard = (dream) => {
    const profile = dream.userId
      ? (followingProfiles[dream.userId] || userSummaries[dream.userId] || null)
      : null;
    const isAnonymous = dream.visibility === 'anonymous';
    const authorUsername = !isAnonymous ? (profile?.username || dream.authorUsername || '') : '';
    const authorHandle = authorUsername ? `@${authorUsername}` : null;
    const avatarIcon = isAnonymous ? 'ghost' : profile?.avatarIcon;
    const avatarBackground = profile?.avatarBackground || DEFAULT_AVATAR_BACKGROUND;
    const avatarColor = profile?.avatarColor || DEFAULT_AVATAR_COLOR;
    const avatarPhotoURL = isAnonymous ? null : (profile?.photoURL || null);
    const dateLabel = dream.createdAt ? formatDreamDate(dream.createdAt) : 'Just now';
    const snippet = dream.content ? (dream.content.length > 240 ? `${dream.content.slice(0, 240)}…` : dream.content) : 'No entry text yet.';
    const visibilityLabel = dream.visibility === 'anonymous' ? 'Anonymous dream'
      : dream.visibility === 'followers' ? 'Followers only'
      : dream.visibility === 'mutuals' ? 'Mutuals only'
      : 'Public dream';
    const showProfileLink = !isAnonymous && Boolean(dream.userId);
    const isOwnerDream = Boolean(viewerId && dream.userId === viewerId);
    const isMenuOpen = feedMenuOpenDreamId === dream.id;
    const profilePath = showProfileLink ? buildProfilePath(authorUsername, dream.userId) : null;
    const handleAuthorNavigation = (event) => {
      if (!showProfileLink) return;
      event.stopPropagation(); event.preventDefault();
      if (profilePath) navigate(profilePath);
    };
    const openDreamDetail = () => {
      void triggerLightHaptic();
      const path = isAnonymous ? `/dream/${dream.id}` : buildDreamPath(authorUsername, dream.userId, dream.id);
      navigate(path, { state: { fromNav: '/feed' } });
    };
    const rawR = dream.viewerReactions?.[viewerId] ?? [];
    const reactionSnapshot = reactionState[dream.id] ?? {
      counts: dream.reactionCounts || {},
      viewerReactions: Array.isArray(rawR) ? rawR : (rawR ? [rawR] : []),
    };
    // The button below shows the viewer's own custom emoji, so the summary row
    // has to leave that one out or the same reaction is rendered twice.
    const viewerCustomEmoji = reactionSnapshot.viewerReactions?.find((e) => e !== defaultReaction) || null;

    const handleCardKeyDown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDreamDetail();
      }
    };

    return (
      <div key={dream.id} className="feed-post" role="button" tabIndex={0} onClick={openDreamDetail} onKeyDown={handleCardKeyDown}>
        <AvatarDisplay
          photoURL={avatarPhotoURL} avatarIcon={avatarIcon}
          avatarBackground={avatarBackground} avatarColor={avatarColor}
          className={`feed-avatar${isAnonymous ? ' feed-avatar--anon' : ''}`}
        />
        <div className="feed-post-main">
          <div className="feed-post-head">
            <div className="feed-post-byline">
              {authorHandle && (showProfileLink
                ? <button type="button" className="feed-author-handle feed-author-link" onClick={handleAuthorNavigation}>{authorHandle}</button>
                : <span className="feed-author-handle">{authorHandle}</span>)}
              {!isAnonymous && <ProBadge subscription={profile?.subscription} />}
              <span className="feed-post-meta">{visibilityLabel}<span aria-hidden="true"> · </span>{dateLabel}</span>
            </div>
            <div className="feed-card-actions" data-feed-menu-root="true">
            <button
              type="button"
              className="feed-card-menu-btn"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              onClick={(event) => toggleFeedMenu(event, dream.id)}
            >
              <FontAwesomeIcon icon={faEllipsisVertical} />
            </button>
            {isMenuOpen && (
              <div className="feed-card-menu" role="menu" aria-label="Dream actions">
                {!isOwnerDream && (
                  <button type="button" className="feed-card-menu-item" role="menuitem" onClick={(event) => { closeFeedMenu(); handleHideDream(event, dream.id); }}>Remove from feed</button>
                )}
                {!isAnonymous && !isOwnerDream && dream.userId && (
                  <button type="button" className="feed-card-menu-item" role="menuitem" onClick={(event) => { closeFeedMenu(); handleBlockAuthor(event, dream.userId, authorHandle); }}>Block user</button>
                )}
                <button type="button" className="feed-card-menu-item feed-card-menu-item-danger" role="menuitem" onClick={(event) => { closeFeedMenu(); handleReportDream(event, dream); }}>Report</button>
                {isOwnerDream && (
                  <button type="button" className="feed-card-menu-item feed-card-menu-item-danger" role="menuitem" onClick={(event) => { closeFeedMenu(); handleRemoveOwnDream(event, dream); }}>Remove post</button>
                )}
              </div>
            )}
            </div>
          </div>
        {(dream.title || (dream.aiGenerated && dream.aiTitle)) ? <h3 className="feed-title">{dream.title || dream.aiTitle}</h3> : null}
        <p className="feed-content">{snippet}</p>
        {dream.aiGenerated && dream.aiInsights && <p className="feed-summary">{dream.aiInsights}</p>}
        {dream.tags && dream.tags.length > 0 && (
          <div className="feed-tags">{dream.tags.map((tag, index) => <span key={index} className="tag">{tag.value}</span>)}</div>
        )}
        <div className="activity-reactions feed-reactions">
          <div className="reaction-buttons">
            <button
              type="button"
              className={`reaction-button${reactionSnapshot.viewerReactions?.includes(defaultReaction) ? ' active' : ''}`}
              onClick={(e) => handleReactionClick(e, dream, defaultReaction)}
              aria-label="React with a heart"
            >
              <FontAwesomeIcon icon={faHeart} className="reaction-icon" />
              <span className="reaction-count">{reactionSnapshot.counts?.[defaultReaction] || 0}</span>
            </button>
            <button type="button" className={`reaction-button${viewerCustomEmoji ? ' active' : ' custom-emoji-trigger'}`} onClick={(e) => openCustomReactionPicker(e, dream)} aria-label="Add emoji reaction">
              {viewerCustomEmoji ? (
                <>
                  <span className="reaction-emoji-text" aria-hidden="true">{viewerCustomEmoji}</span>
                  <span className="reaction-count">{reactionSnapshot.counts?.[viewerCustomEmoji] || 0}</span>
                </>
              ) : <FontAwesomeIcon icon={faPlus} className="reaction-icon" />}
            </button>
            <button type="button" className="reaction-button" onClick={(e) => { e.stopPropagation(); openDreamDetail(); }} aria-label="Comments">
              <FontAwesomeIcon icon={faComment} className="reaction-icon" />
              <span className="reaction-count">{dream.commentCount || 0}</span>
            </button>
          </div>
          {customReactionTarget === dream.id && (
            <div className="custom-emoji-popover" onClick={(e) => e.stopPropagation()} role="group" aria-label="Add an emoji reaction">
              <div className="emoji-picker-grid">
                {COMMON_EMOJI_REACTIONS.map((emoji) => (
                  <button key={`${dream.id}-picker-${emoji}`} type="button" className={`emoji-option${reactionSnapshot.viewerReactions?.includes(emoji) ? ' selected' : ''}`} onClick={(e) => { e.preventDefault(); handleReactionSelection(dream, emoji); closeCustomReactionPicker(); }}>
                    <span aria-hidden="true">{emoji}</span>
                    <span className="sr-only">React with {emoji}</span>
                  </button>
                ))}
              </div>
              <form className="emoji-input-row" onSubmit={(e) => handleCustomReactionSubmit(e, dream)}>
                <input
                  id={`custom-emoji-${dream.id}`}
                  type="text"
                  ref={(node) => { if (customReactionTarget === dream.id) customEmojiInputRef.current = node; }}
                  inputMode="text" enterKeyHint="done" autoComplete="off" maxLength={4}
                  value={customReactionValue} onChange={(e) => handleCustomEmojiChange(e.target.value)}
                  aria-label="Type an emoji" placeholder="Type or paste an emoji" autoFocus
                />
                <button type="submit" className="primary-btn" disabled={!filterEmojiInput(customReactionValue)}>Add</button>
                <button type="button" className="ghost-btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); closeCustomReactionPicker(); }}>Cancel</button>
              </form>
              {reactionSnapshot.viewerReactions?.some((e) => e !== defaultReaction) && (
                <button type="button" className="emoji-clear-btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleReactionClick(e, dream, reactionSnapshot.viewerReactions.find((e2) => e2 !== defaultReaction)); closeCustomReactionPicker(); }}>
                  Clear emoji reaction
                </button>
              )}
            </div>
          )}
          {Object.entries(reactionSnapshot.counts || {}).some(([e, c]) => c > 0 && e !== defaultReaction && e !== viewerCustomEmoji) ? (
            <div className="reaction-summary">
              {Object.entries(reactionSnapshot.counts || {})
                .filter(([emoji, count]) => count > 0 && emoji !== defaultReaction && emoji !== viewerCustomEmoji)
                .sort(([, a], [, b]) => b - a)
                .map(([emoji, count]) => (
                  <span key={emoji} className="reaction-summary-item">
                    <span aria-hidden="true">{emoji}</span>
                    <span className="reaction-count">{count}</span>
                  </span>
                ))}
            </div>
          ) : null}
        </div>
        </div>
      </div>
    );
  };

  return (
    <div className="page-container feed-page">
      <div className="page-header feed-header">
        <div className="feed-header-top">
          <h1>Feed</h1>
          <button type="button" className="ghost-btn" onClick={() => navigate('/search')}>Find people</button>
        </div>
        <div className="feed-tabs" role="tablist" aria-label="Feed type">
          <button
            type="button" role="tab" aria-selected={activeTab === 'foryou'}
            className={`feed-tab${activeTab === 'foryou' ? ' active' : ''}`}
            onClick={() => { if (activeTab !== 'foryou') void triggerSelectionHaptic(); setActiveTab('foryou'); }}
          >
            For You
          </button>
          <button
            type="button" role="tab" aria-selected={activeTab === 'following'}
            className={`feed-tab${activeTab === 'following' ? ' active' : ''}`}
            onClick={() => { if (activeTab !== 'following') void triggerSelectionHaptic(); setActiveTab('following'); }}
          >
            Following
            {followingIds.length > 0 && (
              <span className="feed-tab-count">{followingIds.length}</span>
            )}
          </button>
        </div>
      </div>

      {error && <div className="alert-banner">{error}</div>}

      {activeTab === 'foryou' && (
        forYouLoading || !forYouLoaded ? (
          <FeedSkeleton count={3} />
        ) : visibleForYouDreams.length === 0 ? (
          <div className="feed-empty-card">
            <p>No public dreams yet.</p>
            <p className="empty-subtitle">When dreamers share publicly, their dreams appear here.</p>
          </div>
        ) : (
          <div className="feed-list">
            {visibleForYouDreams.map(renderDreamCard)}
          </div>
        )
      )}

      {activeTab === 'following' && (
        !followingIdsLoaded ? (
          <FeedSkeleton count={3} />
        ) : followingIds.length === 0 ? (
          <div className="feed-empty-card">
            <p>You are not following anyone yet.</p>
            <p className="empty-subtitle">Follow people from Search to see their dreams here.</p>
            <button type="button" className="primary-btn" onClick={() => navigate('/search')}>Find people</button>
          </div>
        ) : loading ? (
          <FeedSkeleton count={3} />
        ) : visibleDreams.length === 0 ? (
          <div className="feed-empty-card">
            <p>No dreams from the people you follow yet.</p>
            <p className="empty-subtitle">As soon as they share something public or limited to followers, it will appear here.</p>
          </div>
        ) : (
          <>
            <div className="feed-list">
              {visibleDreams.map(renderDreamCard)}
            </div>
            {visibleDreams.length < 5 && (
              <div className="feed-discovery-nudge">
                <p>{visibleDreams.length === 1 ? '1 dream' : `${visibleDreams.length} dreams`} from people you follow.</p>
                <button type="button" onClick={() => setActiveTab('foryou')}>Explore For You →</button>
              </div>
            )}
          </>
        )
      )}

      <Toast message={toast} onDismiss={() => setToast('')} />
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          danger={confirmModal.danger}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
      {reportModal && (
        <div className="report-modal-backdrop" onClick={closeReportModal}>
          <div className="report-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Report dream</h3>
            <p className="report-modal-desc">Select the reason that best describes the issue. Reports are reviewed within 24 hours.</p>
            <div className="report-reasons">
              {['Harassment or bullying', 'Hate speech', 'Sexual content', 'Violence', 'Spam', 'Other'].map((r) => (
                <button key={r} type="button" className={`report-reason-btn${reportReason === r ? ' selected' : ''}`} onClick={() => setReportReason(r)}>{r}</button>
              ))}
            </div>
            <div className="report-modal-actions">
              <button type="button" className="secondary-btn" onClick={closeReportModal}>Cancel</button>
              <button type="button" className="danger-btn" onClick={handleSubmitReport} disabled={!reportReason.trim() || reportBusy}>{reportBusy ? 'Submitting…' : 'Submit report'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

Feed.propTypes = { user: appUserPropType };
