import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPencil, faGear, faLock, faEllipsisVertical } from '@fortawesome/free-solid-svg-icons';
import { useNavigate, useParams } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { supabase } from '../supabase';
import { mapProfile, mapDream } from '../utils/mappers';
import { AVATAR_ICONS, AVATAR_BACKGROUNDS, AVATAR_COLORS, DEFAULT_AVATAR_BACKGROUND, DEFAULT_AVATAR_COLOR, getAvatarIconById } from '../constants/avatarOptions';
import AvatarDisplay from '../components/AvatarDisplay';
import ProBadge from '../components/ProBadge';
import { ProfilePageSkeleton, ProfileDreamsLoadingSkeleton } from '../components/SkeletonLoader';
import { formatDreamDate } from '../utils/dates';
import { buildProfilePath, buildDreamPath } from '../utils/urlHelpers';
import { triggerLightHaptic, triggerSuccessHaptic, triggerErrorHaptic } from '../utils/haptics';
import useEscapeKey from '../hooks/useEscapeKey';
import useRefreshSignal from '../hooks/useRefreshSignal';
import { logActivityEvent } from '../services/ActivityService';
import Toast from '../components/Toast';
import { ACCOUNT_VISIBILITY, canViewerSeeDream, normalizeAccountVisibility } from '../utils/privacy';
import './Profile.css';
import { appUserPropType } from '../propTypes';

const DEFAULT_API_ORIGIN = 'https://www.nightlink.dev';

const resolveAccountEndpoint = () => {
  const configuredEndpoint = (import.meta.env.VITE_ACCOUNT_ENDPOINT || '').trim();
  if (configuredEndpoint) return configuredEndpoint;

  const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || '').trim();
  if (configuredApiBase) return `${configuredApiBase.replace(/\/$/, '')}/api/account`;

  if (typeof window !== 'undefined' && window.location?.origin) {
    return '/api/account';
  }

  return `${DEFAULT_API_ORIGIN}/api/account`;
};

const ACCOUNT_ENDPOINT = resolveAccountEndpoint();

export default function Profile({ user }) {
  const { handle: routeHandle } = useParams();
  const [targetUserId, setTargetUserId] = useState(() => (routeHandle ? null : (user?.uid || null)));
  const viewingOwnProfile = Boolean(user?.uid && targetUserId && targetUserId === user.uid);
  const [userData, setUserData] = useState(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileNotFound, setProfileNotFound] = useState(false);
  const [dreams, setDreams] = useState([]);
  const [dreamsLoading, setDreamsLoading] = useState(true);
  const [taggedDreams, setTaggedDreams] = useState([]);
  const [taggedDreamsLoading, setTaggedDreamsLoading] = useState(true);
  const [dreamTab, setDreamTab] = useState('authored');
  const [viewerData, setViewerData] = useState(null);
  const [followAction, setFollowAction] = useState({ type: null });
  const [toast, setToast] = useState('');
  const [reportModal, setReportModal] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const [followRequestState, setFollowRequestState] = useState('none');
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const navigate = useNavigate();
  const viewerId = user?.uid || null;
  const isNativeIOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';


  useEffect(() => {
    if (!profileMenuOpen || isNativeIOS) return undefined;
    const closeOnOutside = (event) => {
      if (!profileMenuRef.current?.contains(event.target)) setProfileMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [profileMenuOpen, isNativeIOS]);

  useEffect(() => {
    if (!isNativeIOS) return undefined;
    const handleOpenProfileMenu = () => {
      if (!viewingOwnProfile && targetUserId) {
        setProfileMenuOpen(true);
      }
    };

    window.addEventListener('nightlink:open-profile-menu', handleOpenProfileMenu);
    return () => window.removeEventListener('nightlink:open-profile-menu', handleOpenProfileMenu);
  }, [isNativeIOS, targetUserId, viewingOwnProfile]);

  useEffect(() => {
    if (!routeHandle) {
      setTargetUserId(user?.uid || null);
      setProfileNotFound(false);
      return;
    }

    let cancelled = false;
    const resolveHandle = async () => {
      setProfileLoading(true);
      setProfileNotFound(false);
      setUserData(null);
      try {
        // Try as UUID first (direct ID)
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRe.test(routeHandle)) {
          const { data } = await supabase.from('profiles').select('id').eq('id', routeHandle).single();
          if (!cancelled && data) { setTargetUserId(data.id); return; }
        }
        // Fall back to normalized username lookup
        const { data } = await supabase
          .from('profiles')
          .select('id')
          .eq('normalized_username', routeHandle.toLowerCase())
          .single();
        if (!cancelled) {
          if (data) { setTargetUserId(data.id); }
          else { setTargetUserId(null); setProfileNotFound(true); setProfileLoading(false); }
        }
      } catch {
        if (!cancelled) { setTargetUserId(null); setProfileNotFound(true); setProfileLoading(false); }
      }
    };
    resolveHandle();
    return () => { cancelled = true; };
  }, [routeHandle, user?.uid]);

  // Load viewer's own profile (for following state)
  useEffect(() => {
    if (!viewerId) { setViewerData(null); return; }
    supabase.from('profiles').select('following_ids, follower_ids, username, settings').eq('id', viewerId).single()
      .then(({ data }) => setViewerData(data ? mapProfile(data) : null));
  }, [viewerId]);

  useEffect(() => {
    if (!targetUserId) return;
    setProfileNotFound(false);
    setProfileLoading(true);
    setUserData(null);
    setDreams([]);
    setDreamsLoading(true);
    setTaggedDreams([]);
    setTaggedDreamsLoading(true);
    setDreamTab('authored');
    setFollowRequestState('none');
    setProfileMenuOpen(false);

    supabase.from('profiles').select('*').eq('id', targetUserId).single()
      .then(({ data }) => {
        if (!data) { setProfileNotFound(true); setProfileLoading(false); return; }
        setUserData(mapProfile(data));
        setProfileLoading(false);
      });
  }, [targetUserId, viewerId, refreshKey]);

  useEffect(() => {
    if (!targetUserId) return;
    let q = supabase.from('dreams').select('*').eq('user_id', targetUserId).order('created_at', { ascending: false });
    if (!viewingOwnProfile) q = q.in('visibility', ['public', 'anonymous', 'followers', 'mutuals']);
    q.then(({ data }) => {
      setDreams((data || []).map(mapDream));
      setDreamsLoading(false);
    });
  }, [targetUserId, viewingOwnProfile, refreshKey]);

  useEffect(() => {
    if (!viewerId || !targetUserId || viewingOwnProfile) {
      setFollowRequestState('none');
      return;
    }

    let cancelled = false;
    const fetchFollowRequestState = async () => {
      try {
        const { data } = await supabase
          .from('follow_requests')
          .select('status')
          .eq('requester_id', viewerId)
          .eq('target_id', targetUserId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!cancelled) {
          setFollowRequestState(data?.status === 'pending' ? 'pending' : 'none');
        }
      } catch {
        if (!cancelled) setFollowRequestState('none');
      }
    };

    fetchFollowRequestState();
    return () => {
      cancelled = true;
    };
  }, [targetUserId, viewerId, viewingOwnProfile]);

  useEffect(() => {
    if (!targetUserId) { setTaggedDreams([]); setTaggedDreamsLoading(false); return; }
    setTaggedDreamsLoading(true);
    supabase.from('dreams').select('*').contains('tagged_user_ids', [targetUserId])
      .order('created_at', { ascending: false })
      .then(async ({ data }) => {
        const baseList = (data || []).map(mapDream);
        const authorIds = [...new Set(baseList.map((d) => d.userId).filter((id) => id && id !== targetUserId))];
        let authorMap = {};
        if (authorIds.length) {
          const { data: profiles } = await supabase.from('profiles').select('id, display_name, username').in('id', authorIds);
          (profiles || []).forEach((p) => { authorMap[p.id] = p; });
        }
        setTaggedDreams(baseList.map((d) => authorMap[d.userId] ? { ...d, authorProfile: mapProfile({ ...authorMap[d.userId], id: d.userId }) } : d));
        setTaggedDreamsLoading(false);
      });
  }, [targetUserId]);

  const handleFollow = async () => {
    if (!user?.uid || !targetUserId || viewingOwnProfile || followAction.type) return;
    setFollowAction({ type: 'follow' });
    try {
      const targetAccountVisibility = normalizeAccountVisibility(userData);
      if (targetAccountVisibility === ACCOUNT_VISIBILITY.PRIVATE && !(viewerData?.followingIds || []).includes(targetUserId)) {
        let requested = false;
        try {
          const { error: requestError } = await supabase.rpc('request_follow', { target_id: targetUserId });
          if (!requestError) requested = true;
        } catch {
          requested = false;
        }

        if (!requested) {
          const { error: insertError } = await supabase
            .from('follow_requests')
            .upsert({
              requester_id: user.uid,
              target_id: targetUserId,
              status: 'pending',
            }, { onConflict: 'requester_id,target_id' });
          if (insertError) throw insertError;
        }

        setFollowRequestState('pending');
        void triggerSuccessHaptic();
        setToast('Follow request sent.');
        return;
      }

      const { error } = await supabase.rpc('follow_user', { target_id: targetUserId });
      if (error) throw error;
      setViewerData((prev) => prev ? { ...prev, followingIds: [...new Set([...(prev.followingIds || []), targetUserId])] } : prev);
      setUserData((prev) => prev ? { ...prev, followerIds: [...new Set([...(prev.followerIds || []), user.uid])] } : prev);
      setFollowRequestState('none');
      void triggerLightHaptic();
      void logActivityEvent(targetUserId, {
        actorId: user.uid,
        actorDisplayName: viewerData?.displayName || null,
        actorUsername: viewerData?.username || null,
        type: 'follow',
      });
    } catch { void triggerErrorHaptic(); setToast('Unable to follow this user.'); }
    finally { setFollowAction({ type: null }); }
  }

  const handleUnfollow = async () => {
    if (!user?.uid || !targetUserId || viewingOwnProfile || followAction.type) return;
    if (followRequestState === 'pending') {
      setFollowAction({ type: 'cancelRequest' });
      try {
        let cancelled = false;
        try {
          const { error: cancelError } = await supabase.rpc('cancel_follow_request', { target_id: targetUserId });
          if (!cancelError) cancelled = true;
        } catch {
          cancelled = false;
        }
        if (!cancelled) {
          const { error: deleteError } = await supabase
            .from('follow_requests')
            .delete()
            .eq('requester_id', user.uid)
            .eq('target_id', targetUserId)
            .eq('status', 'pending');
          if (deleteError) throw deleteError;
        }
        setFollowRequestState('none');
      } catch {
        setToast('Unable to cancel request right now.');
      } finally {
        setFollowAction({ type: null });
      }
      return;
    }

    setFollowAction({ type: 'unfollow' });
    try {
      const { error } = await supabase.rpc('unfollow_user', { target_id: targetUserId });
      if (error) throw error;
      setViewerData((prev) => prev ? { ...prev, followingIds: (prev.followingIds || []).filter((id) => id !== targetUserId) } : prev);
      setUserData((prev) => prev ? { ...prev, followerIds: (prev.followerIds || []).filter((id) => id !== user.uid) } : prev);
      void triggerLightHaptic();
      void supabase.from('activity').delete()
        .eq('target_user_id', targetUserId).eq('actor_id', user.uid).eq('type', 'follow');
    } catch { void triggerErrorHaptic(); setToast('Unable to unfollow right now.'); }
    finally { setFollowAction({ type: null }); }
  }

  const handleBlockUser = useCallback(async () => {
    if (!viewerId || !targetUserId || viewingOwnProfile || followAction.type) return;
    setFollowAction({ type: 'block' });
    try {
      const currentSettings = viewerData?.settings || {};
      const currentBlocked = Array.isArray(currentSettings.blockedUserIds) ? currentSettings.blockedUserIds : [];
      const nextBlocked = [...new Set([...currentBlocked, targetUserId])];
      const { error } = await supabase
        .from('profiles')
        .update({ settings: { ...currentSettings, blockedUserIds: nextBlocked } })
        .eq('id', viewerId);
      if (error) throw error;
      setViewerData((prev) => prev ? { ...prev, settings: { ...(prev.settings || {}), blockedUserIds: nextBlocked } } : prev);
      // Auto-unfollow the blocked user in both directions.
      const isFollowing = (viewerData?.followingIds || []).includes(targetUserId);
      if (isFollowing) {
        await supabase.rpc('unfollow_user', { target_id: targetUserId });
        setViewerData((prev) => prev ? { ...prev, followingIds: (prev.followingIds || []).filter((id) => id !== targetUserId) } : prev);
        setUserData((prev) => prev ? { ...prev, followerIds: (prev.followerIds || []).filter((id) => id !== viewerId) } : prev);
      }
      void triggerSuccessHaptic();
      setToast('User blocked. Their content is now hidden from your feed.');
    } catch {
      void triggerErrorHaptic();
      setToast('Could not block this user right now.');
    } finally {
      setFollowAction({ type: null });
    }
  }, [followAction.type, targetUserId, viewerData, viewerId, viewingOwnProfile]);

  const handleUnblockUser = useCallback(async () => {
    if (!viewerId || !targetUserId || viewingOwnProfile || followAction.type) return;
    setFollowAction({ type: 'unblock' });
    try {
      const currentSettings = viewerData?.settings || {};
      const currentBlocked = Array.isArray(currentSettings.blockedUserIds) ? currentSettings.blockedUserIds : [];
      const nextBlocked = currentBlocked.filter((id) => id !== targetUserId);
      const { error } = await supabase
        .from('profiles')
        .update({ settings: { ...currentSettings, blockedUserIds: nextBlocked } })
        .eq('id', viewerId);
      if (error) throw error;
      setViewerData((prev) => prev ? { ...prev, settings: { ...(prev.settings || {}), blockedUserIds: nextBlocked } } : prev);
      void triggerSuccessHaptic();
      setToast('User unblocked.');
    } catch {
      setToast('Could not unblock this user right now.');
    } finally {
      setFollowAction({ type: null });
    }
  }, [followAction.type, targetUserId, viewerData, viewerId, viewingOwnProfile]);

  useRefreshSignal(useCallback(() => setRefreshKey((n) => n + 1), []));

  const closeProfileOverlays = useCallback(() => {
    setProfileMenuOpen(false);
    setReportModal(false);
  }, []);

  useEscapeKey(closeProfileOverlays, reportModal || profileMenuOpen);

  const handleReportUser = useCallback(() => {
    if (!viewerId || !targetUserId || viewingOwnProfile) return;
    setReportReason('');
    setReportModal(true);
  }, [targetUserId, viewerId, viewingOwnProfile]);


  const handleSubmitReport = async () => {
    if (!reportReason.trim()) return;
    setReportBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const idToken = sessionData?.session?.access_token;
      if (!idToken) throw new Error('Please sign in again before reporting.');

      const response = await fetch(ACCOUNT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          action: 'report_content',
          uid: viewerId,
          targetType: 'user',
          targetId: targetUserId,
          targetUserId,
          reason: reportReason.trim(),
          details: `Reported profile from @${userData?.username || 'unknown'}`
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Could not submit report.');
      setReportModal(false);
      setReportReason('');
      void triggerSuccessHaptic();
      setToast('Report submitted. We review safety reports within 24 hours.');
    } catch (error) {
      setToast(error.message || 'Could not submit report.');
    } finally {
      setReportBusy(false);
      setFollowAction({ type: null });
    }
  };

  const handleDreamNavigation = useCallback((dreamId, ownerUsername, ownerId) => {
    if (!dreamId) return;
    const slug = ownerUsername || userData?.username || '';
    const owner = ownerId || targetUserId;
    navigate(buildDreamPath(slug, owner, dreamId), { state: { fromNav: '/profile' } });
  }, [userData?.username, navigate, targetUserId]);

  const handleProfileNavigation = useCallback((profile) => {
    if (!profile) return;
    if (typeof profile === 'string') { navigate(buildProfilePath(null, profile)); return; }
    navigate(buildProfilePath(profile.username, profile.id));
  }, [navigate]);

  const handleOpenConnections = useCallback((tab) => {
    const nextTab = tab === 'following' ? 'following' : 'followers';
    const basePath = routeHandle ? `/profile/${routeHandle}/connections` : '/profile/connections';
    navigate(`${basePath}?tab=${nextTab}`);
  }, [navigate, routeHandle]);

  const viewerFollowingIds  = viewerData?.followingIds || [];
  const viewerBlockedIds = Array.isArray(viewerData?.settings?.blockedUserIds) ? viewerData.settings.blockedUserIds : [];
  const targetFollowerIds   = userData?.followerIds  || [];
  const targetFollowingIds  = userData?.followingIds || [];
  const isFollowingTarget   = !viewingOwnProfile && viewerFollowingIds.includes(targetUserId);
  const hasPendingFollowRequest = !isFollowingTarget && followRequestState === 'pending';
  const targetAccountVisibility = normalizeAccountVisibility(userData);
  const isPrivateAccount = targetAccountVisibility === ACCOUNT_VISIBILITY.PRIVATE;
  const isLockedProfileView = !viewingOwnProfile && isPrivateAccount && !isFollowingTarget;
  const isBlockedTarget = !viewingOwnProfile && viewerBlockedIds.includes(targetUserId);
  const followsYou          = !viewingOwnProfile && targetFollowingIds.includes(user?.uid);
  const viewerFollowedByTarget = useMemo(() => !viewingOwnProfile && !!viewerId && targetFollowingIds.includes(viewerId), [viewerId, viewingOwnProfile, targetFollowingIds]);
  const activeProfileUsername = viewingOwnProfile ? (userData?.username || viewerData?.username || '') : (userData?.username || '');
  const displayAvatarIconId  = userData?.avatarIcon || AVATAR_ICONS[0].id;
  const displayAvatarBackground = userData?.avatarBackground || AVATAR_BACKGROUNDS[0];
  const displayAvatarColor   = userData?.avatarColor || AVATAR_COLORS[0];
  const selectedIcon = useMemo(() => getAvatarIconById(displayAvatarIconId), [displayAvatarIconId]);
  const isFollowActionBusy = Boolean(followAction.type);
  // Busy labels are per-action: blocking someone should not relabel the
  // Follow and Report buttons as "Working…" too.
  const isFollowBusy = ['follow', 'unfollow', 'cancelRequest'].includes(followAction.type);
  const isBlockBusy = ['block', 'unblock'].includes(followAction.type);

  const viewerCanSeeTaggedDream = useCallback((dream) => {
    if (!dream) return false;
    const vis = dream.visibility || 'private';
    if (vis === 'private') return viewerId && dream.userId === viewerId;
    if (viewerId && (dream.excludedViewerIds || []).includes(viewerId)) return false;
    if (viewerId && dream.userId === viewerId) return true;
    if (viewerId && (dream.taggedUserIds || []).includes(viewerId)) return true;
    if (viewerId === targetUserId) return true;
    if (vis === 'public' || vis === 'anonymous') return true;
    if (vis === 'followers') return !!viewerId && (dream.authorProfile?.followerIds || []).includes(viewerId);
    if (vis === 'mutuals') {
      return !!viewerId
        && (dream.authorProfile?.followerIds || []).includes(viewerId)
        && (dream.authorProfile?.followingIds || []).includes(viewerId);
    }
    return false;
  }, [viewerId, targetUserId]);

  const displayedDreams = useMemo(() => {
    if (viewingOwnProfile) return dreams.filter((d) => d && d.visibility !== 'private' && d.visibility !== 'anonymous');
    // Hide all dreams if the profile owner is blocked.
    if (isBlockedTarget) return [];
    return dreams.filter((d) => d && canViewerSeeDream({
      dream: d,
      viewerId,
      ownerProfile: userData,
      isPending: hasPendingFollowRequest,
    }));
  }, [dreams, viewingOwnProfile, viewerId, isBlockedTarget, userData, hasPendingFollowRequest]);

  const taggedDreamsForProfile = useMemo(() => {
    if (!targetUserId) return [];
    return taggedDreams
      .filter((d) => d && (d.taggedUserIds || []).includes(targetUserId) && (viewerId === targetUserId || viewerCanSeeTaggedDream(d)))
      .sort((a, b) => ((b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0)));
  }, [taggedDreams, targetUserId, viewerId, viewerCanSeeTaggedDream]);

  if (profileNotFound) return <div className="page-container">We could not find that dreamer.</div>;
  // A handle still being resolved has no target id yet, so keep the skeleton up
  // rather than flashing "Profile unavailable." on the very first paint.
  if (profileLoading || !targetUserId || !userData) {
    if (!targetUserId && !routeHandle) return <div className="page-container">Profile unavailable.</div>;
    return (
      <div className="page-container">
        <ProfilePageSkeleton />
      </div>
    );
  }

  const isTaggedTab = dreamTab === 'tagged';
  const activeDreams = isTaggedTab ? taggedDreamsForProfile : displayedDreams;
  const activeDreamsLoading = isTaggedTab ? taggedDreamsLoading : dreamsLoading;
  const dreamSectionTitle = isTaggedTab ? (viewingOwnProfile ? 'Tagged dreams' : 'Tagged for this dreamer') : (viewingOwnProfile ? 'Your dreams' : 'Recent dreams');
  const dreamSectionSubtitle = isTaggedTab
    ? (viewingOwnProfile ? 'Anytime someone mentions you, it lands in this list.' : 'Entries that mention this dreamer and are visible to you.')
    : (viewingOwnProfile ? 'A gallery of your latest journal entries.' : 'Only entries they have shared with you appear here.');
  const emptyPrimary = isTaggedTab ? (viewingOwnProfile ? 'Nobody has tagged you yet' : 'No tagged dreams to show') : (viewingOwnProfile ? 'No dreams yet' : 'No dreams shared with you yet');
  const emptySecondary = isTaggedTab
    ? (viewingOwnProfile ? 'When another dreamer mentions you, their entry appears here automatically.' : 'As soon as a visible tagged entry exists, it will show up in this tab.')
    : (viewingOwnProfile ? 'Start a new entry to see it here.' : viewerFollowedByTarget ? 'They have not shared any public or limited dreams recently.' : 'This dreamer only shares entries with people they follow.');

  const renderDreamPreview = (dream) => {
    const title = dream.title || (dream.aiGenerated ? dream.aiTitle?.trim() : '');
    const snippet = dream.content?.length > 180 ? `${dream.content.slice(0, 180)}…` : dream.content;
    const dateLabel = dream.createdAt ? formatDreamDate(dream.createdAt, 'MMM d') : 'Pending';
    const visLabel = dream.visibility === 'anonymous'
      ? 'Anon'
      : dream.visibility === 'public'
        ? 'Public'
        : dream.visibility === 'followers'
          ? 'Followers'
          : dream.visibility === 'mutuals'
            ? 'Mutuals'
            : 'Private';
    const hasAi = Boolean(dream.aiGenerated && dream.aiInsights);
    const tagCount = dream.tags?.length || 0;
    const taggedCount = Array.isArray(dream.taggedUsers) ? dream.taggedUsers.length : 0;
    return (
      <div key={dream.id} className={`profile-dream-card${hasAi ? ' profile-dream-card--analyzed' : ''}`} role="button" tabIndex={0}
        onClick={() => handleDreamNavigation(dream.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleDreamNavigation(dream.id); } }}>
        <div className="profile-dream-top">
          <div className="dream-date-pill">{dateLabel}</div>
          <div className={`profile-vis-pill profile-vis--${dream.visibility || 'private'}`}>{visLabel}</div>
          {hasAi && <span className="profile-ai-badge" aria-label="AI analyzed">✦</span>}
        </div>
        {title ? <h3 className="profile-dream-title">{title}</h3> : <p className="pending-title">Untitled</p>}
        <p className="profile-dream-snippet">{snippet}</p>
        {(tagCount > 0 || taggedCount > 0) && (
          <div className="profile-dream-footer-meta">
            {tagCount > 0 && <span className="profile-tag-count">{tagCount} {tagCount === 1 ? 'tag' : 'tags'}</span>}
            {taggedCount > 0 && <span className="profile-tag-count">{taggedCount} tagged</span>}
          </div>
        )}
      </div>
    );
  };

  const renderTaggedDream = (dream) => {
    const isAnonymous = dream.visibility === 'anonymous';
    const authorName = isAnonymous ? 'Anonymous dreamer' : dream.authorProfile?.displayName || 'Dreamer';
    const authorHandle = !isAnonymous ? (dream.authorProfile?.username || '') : '';
    const dateLabel = dream.createdAt ? formatDreamDate(dream.createdAt) : 'Shared recently';
    const snippet = dream.content?.length > 200 ? `${dream.content.slice(0, 200)}…` : (dream.content || 'No description yet.');
    return (
      <div key={dream.id} className="tagged-dream-card" role="button" tabIndex={0}
        onClick={() => handleDreamNavigation(dream.id, authorHandle, dream.userId)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleDreamNavigation(dream.id, authorHandle, dream.userId); } }}>
        <div className="tagged-dream-head">
          <div>
            <p className="tagged-author">{authorName}</p>
            <p className="tagged-meta">{authorHandle ? `@${authorHandle} • ` : ''}{dateLabel}</p>
          </div>
          {!isAnonymous && dream.userId && (
            <button type="button" className="tagged-view-profile" onClick={(e) => { e.stopPropagation(); handleProfileNavigation({ id: dream.userId, username: authorHandle }); }}>
              View profile
            </button>
          )}
        </div>
        <p className="tagged-snippet">{snippet}</p>
        {dream.aiGenerated && dream.aiInsights && <p className="tagged-summary">{dream.aiInsights}</p>}
        <div className="tagged-pill-row">
          <span className="tagged-pill shared-pill">Shared with you</span>
          {isAnonymous && <span className="tagged-pill muted-pill">Anonymous</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="page-container stream-page">
      <div className="profile-header">
        {!viewingOwnProfile && (
          <div className="profile-menu-root" ref={profileMenuRef}>
            <button
              type="button"
              className="profile-menu-btn"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={profileMenuOpen}
              onClick={() => setProfileMenuOpen((open) => !open)}
            >
              <FontAwesomeIcon icon={faEllipsisVertical} />
            </button>
            {profileMenuOpen && !isNativeIOS && (
              <div className="profile-menu" role="menu" aria-label="Profile actions">
                <button
                  type="button"
                  className="profile-menu-item"
                  role="menuitem"
                  disabled={isFollowActionBusy}
                  onClick={() => { setProfileMenuOpen(false); if (isBlockedTarget) handleUnblockUser(); else handleBlockUser(); }}
                >
                  {isBlockBusy ? 'Working…' : isBlockedTarget ? 'Unblock user' : 'Block user'}
                </button>
                <button
                  type="button"
                  className="profile-menu-item profile-menu-item-danger"
                  role="menuitem"
                  disabled={isFollowActionBusy}
                  onClick={() => { setProfileMenuOpen(false); handleReportUser(); }}
                >
                  Report user
                </button>
              </div>
            )}
          </div>
        )}
        <div className="profile-avatar">
          <AvatarDisplay
            photoURL={userData.photoURL}
            avatarIcon={displayAvatarIconId}
            avatarBackground={displayAvatarBackground}
            avatarColor={displayAvatarColor}
            className="avatar-circle"
            style={{ fontSize: '2.4rem' }}
            aria-label="Profile avatar"
          />
        </div>

        <div className="profile-info">
            <h1>{userData.displayName || 'Dreamer'} <ProBadge subscription={userData.subscription} /></h1>
            {userData.username && <p className="profile-username">@{userData.username}</p>}
            {userData.settings?.bio && <p className="profile-bio">{userData.settings.bio}</p>}
            {viewingOwnProfile && (
              <div className="profile-btn-row">
                <button type="button" onClick={() => navigate('/profile/edit')} className="edit-profile-btn"><FontAwesomeIcon icon={faPencil} /><span>Edit Profile</span></button>
                {!isNativeIOS && (
                  <button type="button" className="settings-btn" onClick={() => navigate('/settings')}><FontAwesomeIcon icon={faGear} /><span>Settings</span></button>
                )}
              </div>
            )}
            {!viewingOwnProfile && (
              <div className="follow-actions">
                <div className="follow-actions-row follow-actions-row-primary">
                  <button
                    type="button"
                    className={`follow-action-btn ${(isFollowingTarget || hasPendingFollowRequest) ? 'follow-action-btn-following' : 'follow-action-btn-follow'}`}
                    onClick={(isFollowingTarget || hasPendingFollowRequest) ? handleUnfollow : handleFollow}
                    disabled={isFollowActionBusy || isBlockedTarget}
                  >
                    {isFollowBusy ? 'Working…' : isFollowingTarget ? 'Following' : hasPendingFollowRequest ? 'Requested' : 'Follow'}
                  </button>
                  {followsYou && <span className="follow-note follow-note-compact">Follows you</span>}
                </div>
                {isLockedProfileView && (
                  <div className="profile-lock-note" role="status" aria-live="polite">
                    <FontAwesomeIcon icon={faLock} aria-hidden="true" />
                    <span>Private profile. Follow to request access.</span>
                  </div>
                )}
                {isBlockedTarget && <span className="follow-note follow-note-compact">Blocked</span>}
              </div>
            )}
          </div>
      </div>

      <div className="profile-stats">
        <button type="button" className="stat-item stat-button" onClick={() => handleOpenConnections('followers')}>
          <div className="stat-value">{targetFollowerIds.length}</div><div className="stat-label">Followers</div>
        </button>
        <button type="button" className="stat-item stat-button" onClick={() => handleOpenConnections('following')}>
          <div className="stat-value">{targetFollowingIds.length}</div><div className="stat-label">Following</div>
        </button>
      </div>

      <div className="profile-dreams">
        <div className="profile-dreams-head">
          <div className="profile-dreams-head-top">
            <h2>{dreamSectionTitle}</h2>
            <p className="profile-dreams-subtitle">{dreamSectionSubtitle}</p>
          </div>
          <div className="dream-tab-group">
            <button type="button" className={isTaggedTab ? 'dream-tab' : 'dream-tab active'} onClick={() => setDreamTab('authored')} aria-pressed={dreamTab === 'authored'}>
              {viewingOwnProfile ? 'Your dreams' : 'Their dreams'}
            </button>
            <button type="button" className={isTaggedTab ? 'dream-tab active' : 'dream-tab'} onClick={() => setDreamTab('tagged')} aria-pressed={dreamTab === 'tagged'}>
              {viewingOwnProfile ? 'Tagged' : 'Tagged dreams'}
            </button>
          </div>
        </div>
        {activeDreamsLoading ? (
          <ProfileDreamsLoadingSkeleton />
        ) : activeDreams.length === 0 ? (
          <div className="profile-dreams-empty"><p>{emptyPrimary}</p><p className="empty-subtitle">{emptySecondary}</p></div>
        ) : (
          <div className="profile-dream-grid">
            {isTaggedTab ? activeDreams.map((d) => renderTaggedDream(d)) : activeDreams.map(renderDreamPreview)}
          </div>
        )}
      </div>

      <Toast message={toast} onDismiss={() => setToast('')} />

      {reportModal && (
        <div className="report-modal-backdrop" onClick={() => setReportModal(false)}>
          <div className="report-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Report user</h3>
            <p className="report-modal-desc">Select the reason. Reports are reviewed within 24 hours.</p>
            <div className="report-reasons">
              {['Harassment or bullying', 'Hate speech', 'Sexual content', 'Violence', 'Spam', 'Other'].map((r) => (
                <button key={r} type="button" className={`report-reason-btn${reportReason === r ? ' selected' : ''}`} onClick={() => setReportReason(r)}>{r}</button>
              ))}
            </div>
            <div className="report-modal-actions">
              <button type="button" className="secondary-btn" onClick={() => setReportModal(false)}>Cancel</button>
              <button type="button" className="danger-btn" onClick={handleSubmitReport} disabled={!reportReason.trim() || reportBusy}>{reportBusy ? 'Submitting…' : 'Submit report'}</button>
            </div>
          </div>
        </div>
      )}

      {profileMenuOpen && !viewingOwnProfile && isNativeIOS && (
        <div className="report-modal-backdrop" onClick={() => setProfileMenuOpen(false)}>
          <div className="report-modal" onClick={(e) => e.stopPropagation()}>
            <h3>User actions</h3>
            <div className="report-modal-actions">
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  setProfileMenuOpen(false);
                  if (isBlockedTarget) handleUnblockUser();
                  else handleBlockUser();
                }}
                disabled={isFollowActionBusy}
              >
                {isBlockBusy ? 'Working…' : isBlockedTarget ? 'Unblock user' : 'Block user'}
              </button>
              <button
                type="button"
                className="danger-btn"
                onClick={() => {
                  setProfileMenuOpen(false);
                  handleReportUser();
                }}
                disabled={isFollowActionBusy}
              >
                Report user
              </button>
              <button type="button" className="secondary-btn" onClick={() => setProfileMenuOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

Profile.propTypes = {
  user: appUserPropType
};
