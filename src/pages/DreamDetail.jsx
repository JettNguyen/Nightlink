import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import PropTypes from 'prop-types';
import Overlay from '../components/Overlay';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeart, faPlus, faLock, faChevronDown, faEllipsisVertical, faComment } from '@fortawesome/free-solid-svg-icons'; // faPlus kept for emoji picker trigger
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { Capacitor } from '@capacitor/core';
import { triggerLightHaptic, triggerSelectionHaptic, triggerSuccessHaptic, triggerErrorHaptic } from '../utils/haptics';
import { supabase } from '../supabase';
import { mapDream, mapProfile, mapComment } from '../utils/mappers';
import LoadingIndicator from '../components/LoadingIndicator';
import { DreamDetailSkeleton } from '../components/SkeletonLoader';
import ReactionInsightsModal from '../components/ReactionInsightsModal';
import { logActivityEvents } from '../services/ActivityService';
import updateDreamReaction, { toggleCommentHeart } from '../services/ReactionService';
import fetchUserSummaries from '../services/UserService';
import { formatDateInputValue, formatDreamDate, parseDateInputValue } from '../utils/dates';
import { getModerationFeedback, sanitizeAiGeneratedContent } from '../utils/contentModeration';
import Toast from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import useEscapeKey from '../hooks/useEscapeKey';
import VoiceInput, { VoiceField } from '../components/VoiceInput';
import AvatarDisplay from '../components/AvatarDisplay';
import ProBadge from '../components/ProBadge';
import { buildProfilePath } from '../utils/urlHelpers';
import { DEFAULT_AVATAR_BACKGROUND, DEFAULT_AVATAR_COLOR } from '../constants/avatarOptions';
import './DreamDetail.css';
import { appUserPropType } from '../propTypes';
import { COMMON_EMOJI_REACTIONS, filterEmojiInput } from '../constants/emojiOptions';
import { useRcCustomerInfo } from '../contexts/SubscriptionContext';
import { isProFromCustomerInfo, IS_RC_SUPPORTED, syncCustomerInfoToSupabase } from '../utils/purchases';

// The wording of each named style lives on the server (api/ai.js), keyed by the
// ids below, so there is exactly one copy of it. Only a custom prompt is sent
// from here. Labels and descriptions are screen copy and belong on the client.
const PROMPT_LABELS = {
  balanced: 'Balanced guide',
  coach: 'Sleep coach',
  therapist: 'Comfort AI',
  scientist: 'Brain scientist',
  mystical: 'Mystic oracle',
  creative: 'Story weaver',
  director: 'Movie director',
  comedian: 'Dream comedian',
  astrology: 'Astrology guide'
};

const PROMPT_DESCRIPTIONS = {
  balanced:  'A grounded, plain-language reading. Picks out a couple of standout symbols, asks one question worth sitting with, and suggests one small thing to try today.',
  coach:     'Reads the dream for signs of stress, overload or avoidance, explains what your nervous system may be working through, and gives you one practical thing to try tonight.',
  therapist: 'Starts with how the dream likely felt, names the need or fear underneath it, and offers a gentler way to hold whatever it surfaced.',
  scientist: 'What your brain was likely doing while this played out, from memory consolidation to threat rehearsal to emotional processing, and why this particular scenario surfaced.',
  mystical:  'Reads the dream through Jungian archetypes and threshold symbols like shadow, guide, and death and rebirth, and what the psyche seems to be negotiating.',
  creative:  'Finds the story hiding in the dream: the wound that starts it, the roles people play, the world it belongs to, and a writing prompt pulled from its strangest detail.',
  director:  'Pitches your dream as a film: the opening shot, the visual grammar, the question it would leave an audience with.',
  comedian:  'Finds the genuinely absurd part and lands a joke on it, without losing the real feeling underneath.',
  astrology: 'Reads the dream against the sky that night: the moon phase and sign, and whichever planets were actually saying something.',
  custom:    'Your own instructions, exactly as you saved them in Settings.',
};

const PROMPT_ID_ALIASES = {
  investigator: 'director'
};

const FREE_ALLOWED_PROMPT_KEYS = new Set(['balanced', 'coach', 'therapist']);

const VISIBILITY_OPTIONS = [
  { value: 'private', label: 'Private', helper: 'Only you can see this.' },
  { value: 'public', label: 'Public', helper: 'Visible on your profile and feed.' },
  { value: 'followers', label: 'Followers', helper: 'People following you can see it.' },
  { value: 'mutuals', label: 'Mutuals', helper: 'Only people you follow back can see it.' }
];

const DEFAULT_API_ORIGIN = 'https://www.nightlink.dev';

const normalizeNativeAiEndpoint = (endpoint) => {
  if (!endpoint) return endpoint;
  if (!Capacitor.isNativePlatform()) return endpoint;
  return endpoint.replace(/^https:\/\/nightlink\.dev(?=\/|$)/i, 'https://www.nightlink.dev');
};

const resolveAiEndpoint = () => {
  const configuredAiEndpoint = (import.meta.env.VITE_AI_ENDPOINT || '').trim();
  if (configuredAiEndpoint) return normalizeNativeAiEndpoint(configuredAiEndpoint);

  const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || '').trim();
  if (configuredApiBase) {
    return normalizeNativeAiEndpoint(`${configuredApiBase.replace(/\/$/, '')}/api/ai`);
  }

  if (Capacitor.isNativePlatform()) {
    return `${DEFAULT_API_ORIGIN}/api/ai`;
  }

  return '/api/ai';
};

const resolveAccountEndpoint = () => {
  const configuredEndpoint = (import.meta.env.VITE_ACCOUNT_ENDPOINT || '').trim();
  if (configuredEndpoint) return configuredEndpoint;

  const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || '').trim();
  if (configuredApiBase) return `${configuredApiBase.replace(/\/$/, '')}/api/account`;

  if (Capacitor.isNativePlatform()) {
    return `${DEFAULT_API_ORIGIN}/api/account`;
  }

  return '/api/account';
};

const AI_URL = resolveAiEndpoint();
const ACCOUNT_ENDPOINT = resolveAccountEndpoint();
const DEFAULT_EMOJI = '💙';
const ACTIVITY_PRIORITY = { mention: 2, reply: 1, comment: 0 };
const INITIAL_INSIGHT_STATE = {
  open: false,
  emoji: '',
  title: '',
  subtitle: '',
  userIds: [],
  anchorRect: null
};

const normalizePromptKey = (key) => PROMPT_ID_ALIASES[key] || key || 'balanced';
const isPromptLockedForTier = (tier, key) => (
  tier !== 'premium' && !FREE_ALLOWED_PROMPT_KEYS.has(normalizePromptKey(key))
);

const normalizeAnchorRect = (rect) => {
  if (!rect) return null;
  const keys = ['top', 'right', 'bottom', 'left', 'width', 'height'];
  const next = {};
  for (const key of keys) {
    const value = typeof rect[key] === 'number' ? rect[key] : Number(rect[key]);
    if (Number.isNaN(value)) {
      return null;
    }
    next[key] = value;
  }
  return next;
};

const visibilityLabel = (v = 'private') => ({
  public: 'Public dream',
  anonymous: 'Anonymous dream',
  followers: 'Shared with followers',
  mutuals: 'Shared with mutuals',
}[v] || 'Private dream');

const canAccess = (dream, uid, author) => {
  if (!dream) return false;
  if (dream.userId === uid) return true;
  if (!uid) return false;

  const vis = dream.visibility || 'private';
  if (vis === 'private') return false;
  
  const excluded = dream.excludedViewerIds || [];
  if (excluded.includes(uid)) return false;
  
  const tagged = dream.taggedUserIds || [];
  if (tagged.includes(uid)) return true;

  if (vis === 'public' || vis === 'anonymous') return true;
  
  const following = author?.followingIds || [];
  const followers = author?.followerIds || [];
  
  if (vis === 'followers') return followers.includes(uid);
  if (vis === 'mutuals') return followers.includes(uid) && following.includes(uid);
  return false;
};

export default function DreamDetail({ user }) {
  const { rcCustomerInfo, accountTier } = useRcCustomerInfo();
  const { dreamId } = useParams();
  const navigate = useNavigate();
  const [dream, setDream] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [updatingVisibility, setUpdatingVisibility] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [dateInput, setDateInput] = useState('');
  const [editingContent, setEditingContent] = useState(false);
  const [contentInput, setContentInput] = useState('');
  const [editableTags, setEditableTags] = useState([]);
  const [newTag, setNewTag] = useState('');
  const [applyingAiTitle, setApplyingAiTitle] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [aiQuota, setAiQuota] = useState(null);
  // Which inline field save is in flight, so its button can disable and say so.
  // The ref is the actual guard: the title input also saves on Enter, which
  // bypasses the disabled attribute entirely and repeats while the key is held.
  const [savingField, setSavingField] = useState(null);
  const savingFieldRef = useRef(null);
  const [promptSelectorOpen, setPromptSelectorOpen] = useState(false);
  const [firstAnalysisPromptSelector, setFirstAnalysisPromptSelector] = useState(false);
  const [selectedPrompt, setSelectedPrompt] = useState(null);
  const [userSettings, setUserSettings] = useState(null);
  const [audienceOptions, setAudienceOptions] = useState([]);
  const [audienceBusy, setAudienceBusy] = useState(false);
  const [audienceLoading, setAudienceLoading] = useState(false);
  const [audienceQuery, setAudienceQuery] = useState('');
  const [excludedViewerIds, setExcludedViewerIds] = useState([]);
  const [taggedPeople, setTaggedPeople] = useState([]);
  const [tagHandle, setTagHandle] = useState('');
  const [taggingBusy, setTaggingBusy] = useState(false);
  const [taggingStatus, setTaggingStatus] = useState('');
  const [viewerProfile, setViewerProfile] = useState(null);
  const [comments, setComments] = useState([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentInput, setCommentInput] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentStatus, setCommentStatus] = useState('');
  const [commentError, setCommentError] = useState('');
  const [removingCommentId, setRemovingCommentId] = useState(null);
  const [heartingCommentIds, setHeartingCommentIds] = useState(() => new Set());
  const [sharingControlsOpen, setSharingControlsOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState(null);
  const [expandedThreads, setExpandedThreads] = useState({});
  const [reactionSnapshot, setReactionSnapshot] = useState({ counts: {}, viewerReactions: [] });
  const [customEmojiValue, setCustomEmojiValue] = useState('');
  const [customEmojiPickerOpen, setCustomEmojiPickerOpen] = useState(false);
  const [userSummaries, setUserSummaries] = useState({});
  const [reactionInsightState, setReactionInsightState] = useState(INITIAL_INSIGHT_STATE);
  const [reportModal, setReportModal] = useState(null); // { targetType, targetId, targetUserId, commentEntry? }
  const [reportReason, setReportReason] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null); // { action: 'deleteComment', commentId, authorId } | { action: 'deleteDream' }
  const viewerId = user?.uid || null;
  const [authorProfile, setAuthorProfile] = useState(null);
  const [isOwner, setIsOwner] = useState(false);
  const [authorMenuOpen, setAuthorMenuOpen] = useState(false);
  const authorMenuRef = useRef(null);
  const location = useLocation();
  const fromNav = location.state?.fromNav || null;
  const commentInputRef = useRef(null);
  const commentsSectionRef = useRef(null);
  const emojiInputRef = useRef(null);
  const userSummariesRef = useRef(userSummaries);
  const reactionInsightOpenRef = useRef(false);
  const hoverCloseTimeoutRef = useRef(null);
  const longPressTimeoutRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  // The saved custom instructions, but only when custom is the style in use and
  // the plan allows it. Everything else is a named style the server words itself.
  const resolveCustomPromptText = useCallback(() => {
    const preset = normalizePromptKey((userSettings?.aiPromptPreset || '').trim() || 'balanced');
    if (preset !== 'custom') return null;
    if (isPromptLockedForTier(aiQuota?.tier || 'free', preset)) return null;
    return (userSettings?.aiPromptCustom || '').trim() || null;
  }, [userSettings, aiQuota?.tier]);
  // Which style Settings is set to. Used both to order the list and to preselect
  // it when the chooser opens.
  const resolveCurrentPromptKey = () => {
    const preset = (userSettings?.aiPromptPreset || '').trim();
    if (preset === 'custom' && userSettings?.aiPromptCustom) return 'custom';
    return normalizePromptKey(preset === 'custom' ? 'balanced' : preset || 'balanced');
  };

  const commentLookup = useMemo(() => (
    comments.reduce((acc, entry) => {
      if (entry?.id) {
        acc[entry.id] = entry;
      }
      return acc;
    }, {})
  ), [comments]);
  const parentLookup = useMemo(() => (
    comments.reduce((acc, entry) => {
      if (entry?.id) {
        acc[entry.id] = entry.parentCommentId || null;
      }
      return acc;
    }, {})
  ), [comments]);
  const commentThreads = useMemo(() => {
    if (!comments.length) return [];
    const clones = comments.map((entry) => ({ ...entry, replies: [] }));
    const cloneMap = clones.reduce((acc, entry) => {
      if (entry?.id) {
        acc[entry.id] = entry;
      }
      return acc;
    }, {});

    const roots = [];
    clones.forEach((entry) => {
      const parentId = entry.parentCommentId;
      if (parentId && cloneMap[parentId]) {
        cloneMap[parentId].replies.push(entry);
      } else {
        roots.push(entry);
      }
    });

    const sortBranch = (node) => {
      if (!node?.replies?.length) return;
      node.replies.sort((a, b) => {
        const aTime = a.createdAt?.getTime?.() || 0;
        const bTime = b.createdAt?.getTime?.() || 0;
        return aTime - bTime;
      });
      node.replies.forEach(sortBranch);
    };

    roots.forEach(sortBranch);
    return roots;
  }, [comments]);

  useEffect(() => {
    userSummariesRef.current = userSummaries;
  }, [userSummaries]);

  useEffect(() => {
    reactionInsightOpenRef.current = reactionInsightState.open;
  }, [reactionInsightState.open]);

  const totalDreamReactions = useMemo(() => (
    Object.values(reactionSnapshot.counts || {}).reduce((sum, value) => sum + (value || 0), 0)
  ), [reactionSnapshot]);

  const viewerDreamReactions = useMemo(() => (
    reactionSnapshot.viewerReactions || []
  ), [reactionSnapshot]);

  const viewerHeartedDream = viewerDreamReactions.includes(DEFAULT_EMOJI);

  // One chip per emoji, counts included, the viewer's own marked as reacted.
  // The row used to show the viewer's emoji on the picker trigger with no count
  // and then list every emoji again underneath, so your own reaction appeared
  // twice and only the second copy was counted.
  const emojiReactionEntries = useMemo(() => (
    Object.entries(reactionSnapshot.counts || {})
      .filter(([emoji, count]) => typeof emoji === 'string' && emoji.trim().length
        && emoji !== DEFAULT_EMOJI && count > 0)
      .sort((a, b) => b[1] - a[1])
  ), [reactionSnapshot]);

  const reactionInsightEntries = useMemo(() => {
    const ids = reactionInsightState.userIds || [];
    if (!ids.length) return [];
    return ids.map((id) => ({
      id,
      displayName: userSummaries[id]?.displayName || 'Dreamer',
      username: userSummaries[id]?.username || '',
      avatarIcon: userSummaries[id]?.avatarIcon || null,
      avatarBackground: userSummaries[id]?.avatarBackground || undefined,
      avatarColor: userSummaries[id]?.avatarColor || undefined
    }));
  }, [reactionInsightState.userIds, userSummaries]);

  const renderReactionSymbol = (emoji) => (
    emoji === DEFAULT_EMOJI
      ? <FontAwesomeIcon icon={faHeart} className="reaction-emoji-icon" aria-hidden="true" />
      : <span className="reaction-emoji" aria-hidden="true">{emoji}</span>
  );

  const ensureUserSummaries = useCallback(async (ids = []) => {
    const normalized = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim().length))];
    if (!normalized.length) return;
    const missing = normalized.filter((id) => !userSummariesRef.current[id]);
    if (!missing.length) return;
    try {
      const fetched = await fetchUserSummaries(missing);
      if (fetched && Object.keys(fetched).length) {
        setUserSummaries((prev) => ({ ...prev, ...fetched }));
      }
    } catch (error) {
      console.error('Failed to fetch user summaries', error);
    }
  }, []);

  // Comment rows store the author's name and handle but not their avatar, so
  // the faces come from the same summary cache the reaction list uses.
  useEffect(() => {
    if (!comments.length) return;
    void ensureUserSummaries(comments.map((entry) => entry.userId));
  }, [comments, ensureUserSummaries]);

  const cancelModalAutoClose = useCallback(() => {
    if (hoverCloseTimeoutRef.current) {
      clearTimeout(hoverCloseTimeoutRef.current);
      hoverCloseTimeoutRef.current = null;
    }
  }, []);

  const scheduleModalAutoClose = useCallback(() => {
    cancelModalAutoClose();
    if (!reactionInsightOpenRef.current) return;
    hoverCloseTimeoutRef.current = setTimeout(() => {
      setReactionInsightState({ ...INITIAL_INSIGHT_STATE });
    }, 220);
  }, [cancelModalAutoClose]);

  const openReactionInsight = useCallback(async (payload = {}) => {
    const ids = [...new Set((payload.userIds || []).filter((id) => typeof id === 'string' && id.trim().length))];
    const anchorRect = normalizeAnchorRect(payload.anchorRect);
    if (!ids.length || !anchorRect) return;
    cancelModalAutoClose();
    await ensureUserSummaries(ids);
    setReactionInsightState({
      open: true,
      anchorRect,
      emoji: payload.emoji || '',
      title: payload.title || 'Reactions',
      subtitle: payload.subtitle || '',
      userIds: ids
    });
  }, [ensureUserSummaries, cancelModalAutoClose]);

  const getDreamReactionUserIds = useCallback((emoji) => {
    if (!emoji || !dream?.viewerReactions) return [];
    return Object.entries(dream.viewerReactions)
      .filter(([, value]) => {
        const arr = Array.isArray(value) ? value : (value ? [value] : []);
        return arr.includes(emoji);
      })
      .map(([userId]) => userId)
      .filter(Boolean);
  }, [dream?.viewerReactions]);

  const getCommentHeartUserIds = useCallback((entry) => (
    Array.isArray(entry?.heartUserIds)
      ? entry.heartUserIds.filter((id) => typeof id === 'string' && id.trim().length)
      : []
  ), []);

  const buildDreamReactionPayload = useCallback((emoji) => {
    const userIds = getDreamReactionUserIds(emoji);
    if (!userIds.length) return null;
    const countLabel = userIds.length === 1 ? '1 person' : `${userIds.length} people`;
    const actionLabel = emoji === DEFAULT_EMOJI ? 'hearted this dream' : 'reacted this way';
    return {
      title: 'Dream reactions',
      subtitle: `${countLabel} ${actionLabel}`,
      emoji: emoji || '',
      userIds
    };
  }, [getDreamReactionUserIds]);

  const buildCommentHeartPayload = useCallback((entry) => {
    const userIds = getCommentHeartUserIds(entry);
    if (!userIds.length) return null;
    const countLabel = userIds.length === 1 ? '1 person' : `${userIds.length} people`;
    return {
      title: 'Comment hearts',
      subtitle: `${countLabel} hearted this comment`,
      emoji: DEFAULT_EMOJI,
      userIds
    };
  }, [getCommentHeartUserIds]);

  const beginLongPressPreview = useCallback((payload, resolveAnchorRect) => {
    if (!payload?.userIds?.length) return;
    if (longPressTimeoutRef.current) {
      clearTimeout(longPressTimeoutRef.current);
    }
    longPressTriggeredRef.current = false;
    longPressTimeoutRef.current = setTimeout(async () => {
      longPressTimeoutRef.current = null;
      longPressTriggeredRef.current = true;
      suppressNextClickRef.current = true;
      const anchorRect = typeof resolveAnchorRect === 'function'
        ? resolveAnchorRect()
        : resolveAnchorRect;
      await openReactionInsight({ ...payload, anchorRect });
    }, 450);
  }, [openReactionInsight]);

  const cancelLongPressPreview = useCallback(() => {
    if (longPressTimeoutRef.current) {
      clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
    const triggered = longPressTriggeredRef.current;
    longPressTriggeredRef.current = false;
    return triggered;
  }, []);

  const consumeSuppressedClick = useCallback((event) => {
    if (!suppressNextClickRef.current) return false;
    suppressNextClickRef.current = false;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    return true;
  }, []);

  const handleTouchEndInteraction = useCallback((event) => {
    if (cancelLongPressPreview()) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      setReactionInsightState({ ...INITIAL_INSIGHT_STATE });
    }
  }, [cancelLongPressPreview]);

  const handleTouchMoveInteraction = useCallback(() => {
    if (longPressTimeoutRef.current) {
      clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  }, []);

  const handleDreamReactionHoverStart = useCallback((event, emoji) => {
    const payload = buildDreamReactionPayload(emoji);
    if (!payload) return;
    const anchorRect = event?.currentTarget?.getBoundingClientRect?.();
    openReactionInsight({ ...payload, anchorRect });
  }, [buildDreamReactionPayload, openReactionInsight]);

  const handleDreamReactionTouchStart = useCallback((event, emoji) => {
    const payload = buildDreamReactionPayload(emoji);
    if (!payload) return;
    const anchorElement = event?.currentTarget || null;
    beginLongPressPreview(payload, () => anchorElement?.getBoundingClientRect?.());
  }, [beginLongPressPreview, buildDreamReactionPayload]);

  const handleCommentHeartHoverStart = useCallback((event, entry) => {
    const payload = buildCommentHeartPayload(entry);
    if (!payload) return;
    const anchorRect = event?.currentTarget?.getBoundingClientRect?.();
    openReactionInsight({ ...payload, anchorRect });
  }, [buildCommentHeartPayload, openReactionInsight]);

  const handleCommentHeartTouchStart = useCallback((event, entry) => {
    const payload = buildCommentHeartPayload(entry);
    if (!payload) return;
    const anchorElement = event?.currentTarget || null;
    beginLongPressPreview(payload, () => anchorElement?.getBoundingClientRect?.());
  }, [beginLongPressPreview, buildCommentHeartPayload]);

  const getRootCommentId = (commentId) => {
    if (!commentId) return null;
    let currentId = commentId;
    const visited = new Set();
    while (parentLookup[currentId]) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      currentId = parentLookup[currentId];
    }
    return currentId || commentId;
  };

  const toggleThreadVisibility = (threadId) => {
    if (!threadId) return;
    setExpandedThreads((prev) => ({
      ...prev,
      [threadId]: !prev[threadId]
    }));
  };

  const clearReplyTarget = () => {
    setReplyTarget(null);
  };

  const closeCustomEmojiPicker = () => {
    setCustomEmojiPickerOpen(false);
    setCustomEmojiValue('');
  };

  const openCustomEmojiPicker = () => {
    setCustomEmojiPickerOpen(true);
    setCustomEmojiValue('');
  };

  const handleCustomEmojiChange = (value) => {
    setCustomEmojiValue(filterEmojiInput(value));
  };

  const handleCustomEmojiSubmit = (event) => {
    event.preventDefault();
    const emoji = filterEmojiInput(customEmojiValue);
    if (!emoji) return;
    handleDreamReactionSelection(emoji);
    closeCustomEmojiPicker();
  };

  const handleDreamReactionSelection = useCallback(async (emoji) => {
    if (!viewerId) {
      alert('Sign in to react to dreams');
      return;
    }

    if (!dream?.id) return;

    const prevReactions = reactionSnapshot.viewerReactions || [];
    const prevCounts = reactionSnapshot.counts || {};
    const isRemoving = emoji === null || prevReactions.includes(emoji);
    void triggerLightHaptic();

    const optimisticCounts = { ...prevCounts };
    let nextReactions;
    if (emoji === null) {
      prevReactions.forEach((e) => { optimisticCounts[e] = Math.max((optimisticCounts[e] || 1) - 1, 0); });
      nextReactions = [];
    } else if (isRemoving) {
      optimisticCounts[emoji] = Math.max((optimisticCounts[emoji] || 1) - 1, 0);
      nextReactions = prevReactions.filter((e) => e !== emoji);
    } else {
      optimisticCounts[emoji] = (optimisticCounts[emoji] || 0) + 1;
      nextReactions = [...prevReactions, emoji];
    }

    setReactionSnapshot({ counts: optimisticCounts, viewerReactions: nextReactions });
    setCustomEmojiPickerOpen(false);
    setCustomEmojiValue('');

    try {
      await updateDreamReaction({
        dreamId: dream.id,
        dreamOwnerId: dream.userId,
        dreamTitleSnapshot: dream.title || dream.aiTitle || 'Dream entry',
        userId: viewerId,
        emoji: emoji ?? null,
        actorDisplayName: user?.displayName || user?.email || 'Nightlink dreamer',
        actorUsername: user?.username || user?.handle || null,
      });
    } catch (error) {
      console.error('Failed to update reaction', error);
      setReactionSnapshot({ counts: prevCounts, viewerReactions: prevReactions });
    }
  }, [dream, reactionSnapshot, user, viewerId]);

  const containerClass = 'page-container dream-detail-page';
  const isNativeIOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
  const goBack = () => {
    if (window.history.length > 2) {
      navigate(-1);
      return;
    }
    if (fromNav) {
      navigate(fromNav);
      return;
    }
    navigate(isOwner ? '/journal' : '/feed');
  };

  useEffect(() => {
    if (!isOwner) {
      setEditingTitle(false);
      setEditingDate(false);
      setEditingContent(false);
    }
  }, [isOwner]);

  useEffect(() => {
    if (!viewerId) {
      setViewerProfile(null);
      setUserSettings(null);
      return undefined;
    }

    let cancelled = false;
    const loadViewerProfile = async () => {
      try {
        const { data: row } = await supabase.from('profiles').select('*').eq('id', viewerId).single();
        if (cancelled) return;
        const data = row ? mapProfile(row) : null;
        setViewerProfile(data);
        setUserSettings(data?.settings || null);
        if (data) {
          const supabaseTier = data?.subscription?.tier || 'free';
          // RC is authoritative on iOS, so prefer live RC state over potentially
          // stale Supabase data so users are never falsely shown as 'free'.
          const rcIsPro = IS_RC_SUPPORTED && isProFromCustomerInfo(rcCustomerInfo);
          const tier = supabaseTier === 'premium' || rcIsPro || accountTier === 'premium' ? 'premium' : 'free';
          const usage = data?.aiUsage || {};
          const thisMonth = new Date().toISOString().slice(0, 7);
          const monthlyCount = (usage.monthYear || '') === thisMonth ? (usage.monthlyCount || 0) : 0;
          const tierLimit = tier === 'premium' ? 30 : 1;
          setAiQuota({
            tier,
            remainingFree: Math.max(0, tierLimit - monthlyCount),
            creditBalance: usage.creditBalance || 0,
          });
        }
      } catch {
        if (!cancelled) {
          setViewerProfile(null);
          setUserSettings(null);
        }
      }
    };

    loadViewerProfile();
    return () => {
      cancelled = true;
    };
  }, [viewerId]);

  // When RC CustomerInfo arrives (async, after profile load), upgrade the tier
  // in aiQuota if RC says the user is Pro but Supabase was still stale.
  // Also re-sync to Supabase so the server's tier check stays consistent.
  useEffect(() => {
    if (!IS_RC_SUPPORTED || !rcCustomerInfo) return;
    const rcIsPro = isProFromCustomerInfo(rcCustomerInfo);
    if (!rcIsPro) return;
    setAiQuota((prev) => {
      if (!prev || prev.tier === 'premium') return prev;
      const tierLimit = 30;
      const used = tierLimit - prev.remainingFree;
      // Supabase was stale, so re-sync and the server sees premium too
      if (viewerId) syncCustomerInfoToSupabase(viewerId, rcCustomerInfo);
      return { ...prev, tier: 'premium', remainingFree: Math.max(0, tierLimit - used) };
    });
  }, [rcCustomerInfo, viewerId]);

  // Same catch-up for the server's answer, which arrives after the profile read
  // and is the only source that knows about comped accounts. Without this the
  // page would keep believing the stale 'free' it read from the profile row.
  useEffect(() => {
    if (accountTier !== 'premium') return;
    setAiQuota((prev) => {
      if (!prev || prev.tier === 'premium') return prev;
      const tierLimit = 30;
      const used = Math.max(0, 1 - prev.remainingFree);
      return { ...prev, tier: 'premium', remainingFree: Math.max(0, tierLimit - used) };
    });
  }, [accountTier]);

  useEffect(() => {
    if (!dreamId) {
      setError('Missing dream id.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    let cancelled = false;

    const applyDreamData = async (dreamRow) => {
      if (!dreamRow) {
        if (!cancelled) { setError('Dream not found.'); setDream(null); setLoading(false); }
        return;
      }
      const dreamData = mapDream(dreamRow);
      const ownerId = dreamData.userId || null;
      let resolvedAuthorProfile = null;
      if (ownerId) {
        try {
          const { data: authorRow } = await supabase.from('profiles').select('*').eq('id', ownerId).single();
          resolvedAuthorProfile = authorRow ? mapProfile(authorRow) : null;
        } catch { resolvedAuthorProfile = null; }
      }
      const hasAccess = canAccess(dreamData, viewerId, resolvedAuthorProfile);
      if (!hasAccess) {
        if (!cancelled) {
          setError('You do not have permission to view this dream.');
          setDream(null); setAuthorProfile(resolvedAuthorProfile); setIsOwner(false); setLoading(false);
        }
        return;
      }
      if (cancelled) return;
      setDream(dreamData);
      setAuthorProfile(resolvedAuthorProfile);
      setIsOwner(Boolean(ownerId && viewerId && ownerId === viewerId));
      setTitleInput(dreamData.title || '');
      setDateInput(formatDateInputValue(dreamData.createdAt));
      setContentInput(dreamData.content || '');
      setEditableTags(Array.isArray(dreamData.tags) ? dreamData.tags : []);
      setExcludedViewerIds(Array.isArray(dreamData.excludedViewerIds) ? dreamData.excludedViewerIds : []);
      setTaggedPeople(Array.isArray(dreamData.taggedUsers) ? dreamData.taggedUsers : []);
      setTaggingStatus(''); setTagHandle(''); setToast(null); setLoading(false);
    };

    supabase.from('dreams').select('*').eq('id', dreamId).single()
      .then(({ data: dreamRow, error: fetchErr }) => {
        if (cancelled) return;
        if (fetchErr) { setError('Failed to load this dream.'); setDream(null); setLoading(false); return; }
        applyDreamData(dreamRow);
      });

    const channel = supabase
      .channel(`dream:${dreamId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dreams', filter: `id=eq.${dreamId}` },
        (payload) => {
          if (cancelled) return;
          const row = payload.new;
          if (!row) { applyDreamData(null); return; }
          // For live updates (e.g. reactions, title edits) merge only the changed
          // fields onto the existing dream instead of re-running the full applyDreamData
          // flow (which re-fetches the author profile and triggers a full page re-render).
          setDream((prev) => {
            if (!prev) return prev; // not yet loaded, let the initial fetch handle it
            const updated = mapDream(row);
            return {
              ...prev,
              // Large text fields may be absent from real-time payload due to Supabase
              // size limits, so fall back to prev to avoid silently clearing content.
              title: updated.title || prev.title,
              content: updated.content || prev.content,
              visibility: updated.visibility || prev.visibility,
              aiGenerated: updated.aiGenerated ?? prev.aiGenerated,
              aiTitle: updated.aiTitle || prev.aiTitle,
              aiInsights: updated.aiInsights || prev.aiInsights,
              aiConnections: updated.aiConnections || prev.aiConnections,
              memoryIndexed: updated.memoryIndexed ?? prev.memoryIndexed,
              tags: updated.tags ?? prev.tags,
              reactionCounts: updated.reactionCounts ?? prev.reactionCounts,
              viewerReactions: updated.viewerReactions ?? prev.viewerReactions,
              commentCount: updated.commentCount ?? prev.commentCount,
              updatedAt: updated.updatedAt || prev.updatedAt,
            };
          });
        })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [dreamId, viewerId]);

  useEffect(() => {
    if (!dreamId) {
      setComments([]);
      setCommentsLoading(false);
      return undefined;
    }

    setCommentsLoading(true);
    setCommentError('');
    let cancelled = false;

    const fetchComments = async () => {
      const { data, error } = await supabase
        .from('comments')
        .select('*')
        .eq('dream_id', dreamId)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (error) { setCommentError('Could not load comments.'); setComments([]); }
      else { setComments((data || []).map(mapComment)); }
      setCommentsLoading(false);
    };

    fetchComments();

    const channel = supabase
      .channel(`comments:${dreamId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comments', filter: `dream_id=eq.${dreamId}` },
        () => fetchComments())
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [dreamId]);

  // Track whether we've initialized reaction state for the current dream so
  // subsequent realtime merges (e.g. other users reacting) don't clobber our
  // own optimistic updates.
  const reactionInitDreamIdRef = useRef(null);

  useEffect(() => {
    if (!dream) {
      reactionInitDreamIdRef.current = null;
      setReactionSnapshot({ counts: {}, viewerReactions: [] });
      setCustomEmojiPickerOpen(false);
      setCustomEmojiValue('');
      return;
    }

    // First load for this dream, so initialize from server data
    if (reactionInitDreamIdRef.current !== dream.id) {
      reactionInitDreamIdRef.current = dream.id;
      const raw = dream.viewerReactions?.[viewerId] ?? [];
      const viewerReactions = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      setReactionSnapshot({
        counts: dream.reactionCounts || {},
        viewerReactions,
      });
      setCustomEmojiPickerOpen(false);
      setCustomEmojiValue('');
    }
    // Subsequent updates (realtime merges) intentionally do NOT reset snapshot,
    // because local optimistic updates from handleDreamReactionSelection win.
  }, [dream, viewerId]);

  useEffect(() => {
    ensureUserSummaries(Object.keys(dream?.viewerReactions || {}));
  }, [dream?.viewerReactions, ensureUserSummaries]);

  useEffect(() => {
    if (!comments.length) return;
    const ids = comments.flatMap((entry) => (
      Array.isArray(entry.heartUserIds) ? entry.heartUserIds : []
    ));
    ensureUserSummaries(ids);
  }, [comments, ensureUserSummaries]);

  useEffect(() => {
    if (!replyTarget) return;
    if (!comments.some((comment) => comment.id === replyTarget.id)) {
      setReplyTarget(null);
    }
  }, [comments, replyTarget]);

  useEffect(() => {
    if (!customEmojiPickerOpen) {
      return;
    }
    const input = emojiInputRef.current;
    if (!input) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange(end, end);
      if (typeof navigator !== 'undefined' && navigator.virtualKeyboard?.show) {
        try {
          navigator.virtualKeyboard.show();
        } catch {
          /* ignored */
        }
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [customEmojiPickerOpen]);

  useEffect(() => () => {
    cancelModalAutoClose();
    if (longPressTimeoutRef.current) {
      clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  }, [cancelModalAutoClose]);

  const formattedDate = useMemo(() => {
    if (!dream?.createdAt) return '';
    try {
      return formatDreamDate(dream.createdAt, 'MMMM d, yyyy');
    } catch {
      return '';
    }
  }, [dream?.createdAt]);

  useEffect(() => {
    if (!user?.uid || !dream || dream.userId !== user.uid) {
      setAudienceOptions([]);
      setAudienceLoading(false);
      setAudienceQuery('');
      return undefined;
    }

    let cancelled = false;
    setAudienceLoading(true);
    setAudienceQuery('');

    const loadFollowing = async () => {
      try {
        const { data: profileRow } = await supabase.from('profiles').select('following_ids').eq('id', user.uid).single();
        const followingIds = profileRow?.following_ids || [];
        const connectionIds = followingIds.filter((id) => id && id !== user.uid);
        if (!connectionIds.length) {
          if (!cancelled) setAudienceOptions([]);
          return;
        }
        const { data: profilesData } = await supabase
          .from('profiles')
          .select('id, display_name, username')
          .in('id', connectionIds);
        if (!cancelled) {
          setAudienceOptions((profilesData || []).map((r) => ({
            id: r.id, displayName: r.display_name || 'Dreamer', username: r.username || '',
          })));
        }
      } catch {
        if (!cancelled) setAudienceOptions([]);
      } finally {
        if (!cancelled) setAudienceLoading(false);
      }
    };

    loadFollowing();
    return () => {
      cancelled = true;
    };
  }, [user?.uid, dream?.userId]);

  const handleVisibilityChange = async (value) => {
    if (!dream || !isOwner || dream.visibility === value) return;
    void triggerSelectionHaptic();
    setUpdatingVisibility(true);
    try {
      const { error } = await supabase.from('dreams').update({ visibility: value }).eq('id', dream.id);
      if (error) throw error;
      const targetIds = new Set([
        ...(Array.isArray(taggedPeople) ? taggedPeople.map((entry) => entry?.userId).filter(Boolean) : []),
        ...comments.map((entry) => entry?.userId).filter(Boolean)
      ]);
      targetIds.delete(viewerId);
      if (targetIds.size) {
        const snapshotTitle = dream?.title?.trim()
          || (dream?.aiGenerated ? dream?.aiTitle : '')
          || 'Untitled dream';
        const actorDisplayName = viewerProfile?.displayName || user?.displayName || 'Dreamer';
        const actorUsername = viewerProfile?.username || user?.username || '';
        const nextDreamOwnerUsername = value === 'anonymous' ? '' : dreamOwnerUsernameForDisplay;
        const events = Array.from(targetIds).map((targetUserId) => ({
          targetUserId,
          payload: {
            actorId: viewerId,
            actorDisplayName,
            actorUsername,
            type: 'dreamUpdate',
            dreamId: dream.id,
            dreamOwnerId: dream.userId || null,
            dreamOwnerUsername: nextDreamOwnerUsername,
            dreamTitleSnapshot: snapshotTitle,
            content: 'Visibility was updated.'
          }
        }));
        if (events.length) {
          await logActivityEvents(events);
        }
      }
    } catch {
      void triggerErrorHaptic();
      setError('Could not update visibility.');
    } finally {
      setUpdatingVisibility(false);
    }
  };

  const beginFieldSave = (field) => {
    if (savingFieldRef.current) return false;
    savingFieldRef.current = field;
    setSavingField(field);
    return true;
  };

  const endFieldSave = () => {
    savingFieldRef.current = null;
    setSavingField(null);
  };

  const handleSaveTitle = async () => {
    if (!dream || !isOwner) return;
    if (!beginFieldSave('title')) return;
    try {
      const { error } = await supabase.from('dreams').update({ title: titleInput.trim() }).eq('id', dream.id);
      if (error) throw error;
      const targetIds = new Set([
        ...(Array.isArray(taggedPeople) ? taggedPeople.map((entry) => entry?.userId).filter(Boolean) : []),
        ...comments.map((entry) => entry?.userId).filter(Boolean)
      ]);
      targetIds.delete(viewerId);
      if (targetIds.size) {
        const snapshotTitle = titleInput.trim() || 'Untitled dream';
        const actorDisplayName = viewerProfile?.displayName || user?.displayName || 'Dreamer';
        const actorUsername = viewerProfile?.username || user?.username || '';
        const events = Array.from(targetIds).map((targetUserId) => ({
          targetUserId,
          payload: {
            actorId: viewerId,
            actorDisplayName,
            actorUsername,
            type: 'dreamUpdate',
            dreamId: dream.id,
            dreamOwnerId: dream.userId || null,
            dreamOwnerUsername: dreamOwnerUsernameForDisplay,
            dreamTitleSnapshot: snapshotTitle,
            content: 'Title was updated.'
          }
        }));
        if (events.length) {
          await logActivityEvents(events);
        }
      }
      setEditingTitle(false);
    } catch {
      setError('Could not update title.');
    } finally {
      endFieldSave();
    }
  };

  const handleSaveDate = async () => {
    if (!dream || !isOwner || !dateInput) return;
    const nextDate = parseDateInputValue(dateInput);
    if (!nextDate) {
      setError('Choose a valid dream date.');
      return;
    }
    if (!beginFieldSave('date')) return;
    try {
      const { error } = await supabase.from('dreams').update({ created_at: nextDate.toISOString() }).eq('id', dream.id);
      if (error) throw error;
      const targetIds = new Set([
        ...(Array.isArray(taggedPeople) ? taggedPeople.map((entry) => entry?.userId).filter(Boolean) : []),
        ...comments.map((entry) => entry?.userId).filter(Boolean)
      ]);
      targetIds.delete(viewerId);
      if (targetIds.size) {
        const snapshotTitle = dream?.title?.trim()
          || (dream?.aiGenerated ? dream?.aiTitle : '')
          || 'Untitled dream';
        const actorDisplayName = viewerProfile?.displayName || user?.displayName || 'Dreamer';
        const actorUsername = viewerProfile?.username || user?.username || '';
        const events = Array.from(targetIds).map((targetUserId) => ({
          targetUserId,
          payload: {
            actorId: viewerId,
            actorDisplayName,
            actorUsername,
            type: 'dreamUpdate',
            dreamId: dream.id,
            dreamOwnerId: dream.userId || null,
            dreamOwnerUsername: dreamOwnerUsernameForDisplay,
            dreamTitleSnapshot: snapshotTitle,
            content: 'Date was updated.'
          }
        }));
        if (events.length) {
          await logActivityEvents(events);
        }
      }
      setEditingDate(false);
    } catch {
      setError('Could not update date.');
    } finally {
      endFieldSave();
    }
  };

  const handleCancelContentEdit = () => {
    setEditingContent(false);
    setContentInput(dream?.content || '');
    setEditableTags(Array.isArray(dream?.tags) ? dream.tags : []);
    setNewTag('');
  };

  const handleSaveContent = async () => {
    if (!dream || !isOwner || !contentInput.trim()) return;
    const contentFeedback = getModerationFeedback(contentInput, { contentType: 'dream text' });
    if (contentFeedback) {
      setError(contentFeedback);
      return;
    }
    if (!beginFieldSave('content')) return;
    try {
      const { error } = await supabase.from('dreams').update({ content: contentInput.trim(), tags: editableTags }).eq('id', dream.id);
      if (error) throw error;
      const targetIds = new Set([
        ...(Array.isArray(taggedPeople) ? taggedPeople.map((entry) => entry?.userId).filter(Boolean) : []),
        ...comments.map((entry) => entry?.userId).filter(Boolean)
      ]);
      targetIds.delete(viewerId);
      if (targetIds.size) {
        const snapshotTitle = dream?.title?.trim()
          || (dream?.aiGenerated ? dream?.aiTitle : '')
          || 'Untitled dream';
        const actorDisplayName = viewerProfile?.displayName || user?.displayName || 'Dreamer';
        const actorUsername = viewerProfile?.username || user?.username || '';
        const events = Array.from(targetIds).map((targetUserId) => ({
          targetUserId,
          payload: {
            actorId: viewerId,
            actorDisplayName,
            actorUsername,
            type: 'dreamUpdate',
            dreamId: dream.id,
            dreamOwnerId: dream.userId || null,
            dreamOwnerUsername: dreamOwnerUsernameForDisplay,
            dreamTitleSnapshot: snapshotTitle,
            content: 'Dream content was updated.'
          }
        }));
        if (events.length) {
          await logActivityEvents(events);
        }
      }
      setEditingContent(false);
      setNewTag('');
    } catch {
      setError('Could not update dream content.');
    } finally {
      endFieldSave();
    }
  };

  const handleAddTag = () => {
    const trimmed = newTag.trim();
    if (!trimmed || editableTags.some((tag) => tag.value === trimmed)) return;
    setEditableTags((prev) => [...prev, { value: trimmed, category: 'theme' }]);
    setNewTag('');
  };

  const handleRemoveTag = (value) => {
    setEditableTags((prev) => prev.filter((tag) => tag.value !== value));
  };

  const persistAudience = async (nextIds) => {
    if (!dream || !isOwner) return;
    setAudienceBusy(true);
    try {
      const { error } = await supabase.from('dreams').update({ excluded_viewer_ids: nextIds }).eq('id', dream.id);
      if (error) throw error;
      setExcludedViewerIds(nextIds);
    } catch {
      setError('Could not update audience overrides.');
    } finally {
      setAudienceBusy(false);
    }
  };

  const handleToggleAudience = (viewerId) => {
    if (!viewerId || !dream || !isOwner) return;
    const next = excludedViewerIds.includes(viewerId)
      ? excludedViewerIds.filter((id) => id !== viewerId)
      : [...excludedViewerIds, viewerId];
    persistAudience(next);
  };

  const normalizeHandle = (value = '') => value.replace(/^@/, '').trim().toLowerCase();

  const extractMentionHandles = (value = '') => {
    const matches = new Set();
    const mentionPattern = /@([a-zA-Z0-9_]+)/g;
    let match = mentionPattern.exec(value);
    while (match) {
      const normalized = normalizeHandle(match[1]);
      if (normalized) {
        matches.add(normalized);
      }
      match = mentionPattern.exec(value);
    }
    return Array.from(matches);
  };

  const resolveMentionTargets = async (text = '') => {
    const handles = extractMentionHandles(text);
    if (!handles.length) return { ids: [], handles: [] };
    try {
      const { data } = await supabase
        .from('profiles')
        .select('id')
        .in('normalized_username', handles);
      return { ids: (data || []).map((r) => r.id), handles };
    } catch {
      return { ids: [], handles };
    }
  };

  const tagSuggestions = useMemo(() => {
    const normalized = normalizeHandle(tagHandle);
    if (!normalized) return [];
    return audienceOptions
      .filter((profile) => {
        if (!profile?.id) return false;
        if (profile.id === user?.uid) return false;
        if (taggedPeople.some((entry) => entry.userId === profile.id)) {
          return false;
        }
        const username = (profile.username || '').toLowerCase();
        const displayName = (profile.displayName || '').toLowerCase();
        return username.includes(normalized) || displayName.includes(normalized);
      })
      .slice(0, 5);
  }, [audienceOptions, tagHandle, taggedPeople, user?.uid]);

  const audienceLookup = useMemo(() => (
    audienceOptions.reduce((acc, profile) => {
      acc[profile.id] = profile;
      return acc;
    }, {})
  ), [audienceOptions]);

  const filteredAudience = useMemo(() => {
    const normalized = audienceQuery.trim().toLowerCase();
    if (!normalized) return [];
    return audienceOptions.filter((profile) => {
      const label = `${profile.displayName || ''} ${profile.username || ''}`.toLowerCase();
      return label.includes(normalized);
    });
  }, [audienceOptions, audienceQuery]);

  const persistTaggedPeople = async (nextList, successMessage) => {
    if (!dream || !isOwner) return;
    setTaggingBusy(true);
    setTaggingStatus('');
    try {
      const { error } = await supabase.from('dreams').update({
        tagged_users: nextList,
        tagged_user_ids: nextList.map((entry) => entry.userId),
      }).eq('id', dream.id);
      if (error) throw error;
      setTaggedPeople(nextList);
      setTagHandle('');
      if (successMessage) setTaggingStatus(successMessage);
    } catch {
      setTaggingStatus('Could not update tagged dreamers.');
    } finally {
      setTaggingBusy(false);
    }
  };

  const handleRemoveTaggedPerson = (personId) => {
    if (!isOwner) return;
    const next = taggedPeople.filter((entry) => entry.userId !== personId);
    persistTaggedPeople(next, 'Removed.');
  };

  const handleSelectTagSuggestion = (profile) => {
    if (!profile?.id || taggingBusy || !isOwner) return;
    if (taggedPeople.some((entry) => entry.userId === profile.id)) {
      setTaggingStatus('Already tagged.');
      return;
    }
    const next = [
      ...taggedPeople,
      {
        userId: profile.id,
        username: profile.username || '',
        displayName: profile.displayName || 'Dreamer'
      }
    ];
    setTagHandle('');
    persistTaggedPeople(next, 'Tagged successfully.');
  };

  const handleAddTaggedPerson = async () => {
    if (taggingBusy || !isOwner) return;
    const raw = tagHandle.trim();
    if (!raw || !user?.uid) return;
    const normalizedHandle = normalizeHandle(raw);
    if (!normalizedHandle) return;
    if (taggedPeople.some((entry) => entry.username?.toLowerCase() === normalizedHandle)) {
      setTaggingStatus('Already tagged.');
      setTagHandle('');
      return;
    }

    try {
      const { data: matchRow } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .eq('normalized_username', normalizedHandle)
        .single();
      if (!matchRow) { setTaggingStatus('No user found for that handle.'); return; }
      if (matchRow.id === user.uid) { setTaggingStatus('You are already the author.'); return; }
      if (taggedPeople.some((entry) => entry.userId === matchRow.id)) { setTaggingStatus('Already tagged.'); return; }
      const next = [...taggedPeople, { userId: matchRow.id, username: matchRow.username || normalizedHandle, displayName: matchRow.display_name || 'Dreamer' }];
      await persistTaggedPeople(next, 'Tagged successfully.');
    } catch {
      setTaggingStatus('Could not tag that user.');
    }
  };

  const handleSubmitComment = async () => {
    if (!viewerId || commentBusy) return;
    const trimmed = commentInput.trim();
    const activeDreamId = dream?.id || dreamId;
    if (!trimmed || !activeDreamId) return;
    const commentFeedback = getModerationFeedback(trimmed, { contentType: 'comment' });
    if (commentFeedback) {
      setCommentStatus(commentFeedback);
      return;
    }

    setCommentBusy(true);
    setCommentStatus('');
    try {
      const currentReplyTarget = replyTarget;
      const mentionTargets = await resolveMentionTargets(trimmed);
      const mentionHandles = Array.isArray(mentionTargets?.handles) ? mentionTargets.handles : [];
      const activityTargets = new Set(mentionTargets.ids);
      if (dream?.userId && dream.userId !== viewerId) {
        activityTargets.add(dream.userId);
      }
      if (currentReplyTarget?.userId && currentReplyTarget.userId !== viewerId) {
        activityTargets.add(currentReplyTarget.userId);
      }
      const activityTargetIds = Array.from(activityTargets);
      const snapshotTitle = dream?.title?.trim()
        || (dream?.aiGenerated ? dream?.aiTitle : '')
        || 'Untitled dream';
      const { data: commentRow, error: insertErr } = await supabase.from('comments').insert({
        content:                trimmed,
        user_id:                viewerId,
        author_display_name:    viewerProfile?.displayName || user?.displayName || 'Dreamer',
        author_username:        viewerProfile?.username || user?.username || '',
        dream_id:               activeDreamId,
        dream_owner_id:         dream?.userId || null,
        dream_owner_username:   dreamOwnerUsernameForDisplay,
        dream_title_snapshot:   snapshotTitle,
        mentions:               mentionTargets.ids,
        mention_handles:        mentionTargets.handles,
        parent_comment_id:      currentReplyTarget?.id || null,
        parent_comment_user_id: currentReplyTarget?.userId || null,
        activity_target_ids:    activityTargetIds,
        heart_user_ids:         [],
        heart_count:            0,
      }).select('id').single();
      if (insertErr) throw insertErr;

      // Optimistically append the new comment so it appears immediately.
      const optimisticComment = {
        id:                  commentRow.id,
        dreamId:             activeDreamId,
        dreamOwnerId:        dream?.userId || null,
        userId:              viewerId,
        authorDisplayName:   viewerProfile?.displayName || user?.displayName || 'Dreamer',
        authorUsername:      viewerProfile?.username || user?.username || '',
        dreamOwnerUsername:  dreamOwnerUsernameForDisplay,
        dreamTitleSnapshot:  snapshotTitle,
        content:             trimmed,
        parentCommentId:     currentReplyTarget?.id || null,
        parentCommentUserId: currentReplyTarget?.userId || null,
        mentions:            mentionTargets.ids,
        mentionHandles:      mentionTargets.handles,
        activityTargetIds:   activityTargetIds,
        heartCount:          0,
        heartUserIds:        [],
        createdAt:           new Date(),
        updatedAt:           null,
      };
      setComments((prev) => [...prev, optimisticComment]);

      const commentDocRef = commentRow;
      const actorDisplayName = viewerProfile?.displayName || user?.displayName || 'Dreamer';
      const actorUsername = viewerProfile?.username || user?.username || '';
      const targetEventMap = new Map();
      const registerActivity = (targetId, type) => {
        if (!targetId || targetId === viewerId) return;
        const priority = ACTIVITY_PRIORITY[type] || 0;
        const existing = targetEventMap.get(targetId);
        if (!existing || priority > existing.priority) {
          targetEventMap.set(targetId, { type, priority });
        }
      };

      (mentionTargets.ids || []).forEach((targetId) => registerActivity(targetId, 'mention'));
      if (dream?.userId) {
        registerActivity(dream.userId, 'comment');
      }
      if (currentReplyTarget?.userId) {
        registerActivity(currentReplyTarget.userId, 'reply');
      }

      const basePayload = {
        actorId: viewerId,
        actorDisplayName,
        actorUsername,
        dreamId: activeDreamId,
        dreamOwnerId: dream?.userId || null,
        dreamOwnerUsername: dreamOwnerUsernameForDisplay,
        dreamTitleSnapshot: snapshotTitle,
        commentId: commentDocRef.id,
        parentCommentId: currentReplyTarget?.id || null,
        parentCommentUserId: currentReplyTarget?.userId || null,
        content: trimmed,
        mentionHandles
      };

      const events = Array.from(targetEventMap.entries()).map(([targetUserId, meta]) => ({
        targetUserId,
        payload: {
          ...basePayload,
          type: meta.type
        }
      }));

      if (events.length) {
        try {
          await logActivityEvents(events);
        } catch (activityError) {
          console.error('logActivityEvents failed', activityError);
        }
      }
      setCommentInput('');
      void triggerSuccessHaptic();
      setCommentStatus('Posted.');
      if (currentReplyTarget?.rootId) {
        setExpandedThreads((prev) => ({
          ...prev,
          [currentReplyTarget.rootId]: true
        }));
      }
      setReplyTarget(null);
    } catch {
      void triggerErrorHaptic();
      setCommentStatus('Could not post your comment.');
    } finally {
      setCommentBusy(false);
    }
  };

  const handleDeleteComment = (commentId, authorId) => {
    if (!commentId || !dream?.id || !viewerId) return;
    if (!isOwner && authorId !== viewerId) return;
    setConfirmModal({ action: 'deleteComment', commentId, authorId });
  };

  const executeDeleteComment = async (commentId) => {
    setConfirmModal(null);
    setRemovingCommentId(commentId);
    setCommentStatus('');
    try {
      const { error } = await supabase.from('comments').delete().eq('id', commentId);
      if (error) throw error;
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch {
      void triggerErrorHaptic();
      setCommentStatus('Could not remove that comment.');
    } finally {
      setRemovingCommentId(null);
    }
  };

  // The comment button in the reaction row. The composer is further down the
  // page, so it scrolls there and takes the caret with it. preventScroll on the
  // focus call, because the browser's own scroll-on-focus would jump straight
  // there and cut the smooth scroll off halfway.
  const handleJumpToComposer = useCallback(() => {
    void triggerLightHaptic();
    const input = commentInputRef.current;
    const target = input || commentsSectionRef.current;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: input ? 'center' : 'start' });
    input?.focus({ preventScroll: true });
  }, []);

  // The composer sits above the list, so its post button only appears once
  // there is something to post. Otherwise a button and its row would push the
  // first comment down the screen on every dream.
  const composerEngaged = Boolean(commentInput.trim().length || replyTarget || commentBusy);

  const handleReplyToComment = (entry) => {
    if (!viewerId || !entry?.id) return;
    if (entry.authorUsername) {
      const mention = `@${entry.authorUsername}`;
      setCommentInput((prev) => {
        const existing = prev || '';
        if (existing.toLowerCase().includes(mention.toLowerCase())) {
          return existing;
        }
        const spacer = existing.trim().length ? ' ' : '';
        return `${existing}${spacer}${mention} `;
      });
    }
    const rootId = getRootCommentId(entry.id) || entry.id;
    setReplyTarget({
      id: entry.id,
      userId: entry.userId || null,
      authorDisplayName: entry.authorDisplayName || 'Dreamer',
      authorUsername: entry.authorUsername || '',
      rootId
    });
    setExpandedThreads((prev) => ({
      ...prev,
      [rootId]: true
    }));
    setCommentStatus('');
    requestAnimationFrame(() => {
      commentInputRef.current?.focus();
    });
  };

  const handleToggleCommentHeart = async (entry) => {
    if (!viewerId || !dream?.id || !entry?.id) return;
    if (heartingCommentIds.has(entry.id)) return;

    setHeartingCommentIds((prev) => {
      const next = new Set(prev);
      next.add(entry.id);
      return next;
    });

    let previousEntry = null;
    setComments((prev) => prev.map((comment) => {
      if (comment.id !== entry.id) return comment;
      previousEntry = comment;
      const hearts = Array.isArray(comment.heartUserIds) ? comment.heartUserIds : [];
      const viewerHearted = hearts.includes(viewerId);
      const nextHearts = viewerHearted ? hearts.filter((id) => id !== viewerId) : [...hearts, viewerId];
      const nextCount = Math.max((comment.heartCount || 0) + (viewerHearted ? -1 : 1), 0);
      return { ...comment, heartUserIds: nextHearts, heartCount: nextCount };
    }));

    try {
      await toggleCommentHeart({
        dreamId: dream.id,
        commentId: entry.id,
        userId: viewerId,
        actorDisplayName: viewerProfile?.displayName || user?.displayName || 'Dreamer',
        actorUsername: viewerProfile?.username || user?.username || '',
        commentAuthorId: entry.userId || null,
        dreamTitleSnapshot: dream?.title || dream?.aiTitle || 'Dream entry'
      });
    } catch (error) {
      console.error('toggleCommentHeart failed', error);
      if (previousEntry) {
        setComments((prev) => prev.map((comment) => (
          comment.id === entry.id ? previousEntry : comment
        )));
      }
    } finally {
      setHeartingCommentIds((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    }
  };

  const handleAnalyzeDream = async ({ customPrompt = null, promptKey = null, skipPromptSelector = false } = {}) => {
    if (!dream || !isOwner) return;
    // A `local-` id means the dream is still an optimistic local copy whose
    // insert has not come back yet. Returning silently here left the button
    // looking live while doing nothing at all: no request, no toast, no log.
    if (dream.id.startsWith('local-')) {
      setToast('This dream is still saving. Try again in a moment.');
      return;
    }

    const trimmedContent = (dream.content || '').trim();
    if (!trimmedContent) {
      setToast('Dream content is empty, nothing to analyze.');
      return;
    }
    const dreamSafetyFeedback = getModerationFeedback(trimmedContent, { contentType: 'dream text' });
    if (dreamSafetyFeedback) {
      setToast(`${dreamSafetyFeedback} Update the dream text, then try AI again.`);
      return;
    }

    // For first analysis, show style selector instead of generating immediately
    if (!dream.aiGenerated && !skipPromptSelector && !customPrompt && !promptKey) {
      setSelectedPrompt(resolveCurrentPromptKey());
      setFirstAnalysisPromptSelector(true);
      return;
    }

    setAnalyzing(true);
    setToast(null);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const idToken = sessionData?.session?.access_token;
      if (!idToken) {
        setToast('Please sign in again to use AI features.');
        setAnalyzing(false);
        return;
      }

      const requestBody = {
        dreamText: trimmedContent,
        idToken,
        dreamId: dream.id,
        dreamDate: dream.createdAt instanceof Date ? dream.createdAt.toISOString() : (dream.createdAt || null),
        isMemoryIndexed: !!dream.memoryIndexed,
      };

      let selectedPromptKey = promptKey;
      if (!selectedPromptKey) {
        selectedPromptKey = normalizePromptKey((userSettings?.aiPromptPreset || '').trim() || 'balanced');
      }
      if (isPromptLockedForTier(aiQuota?.tier || 'free', selectedPromptKey)) {
        selectedPromptKey = 'balanced';
      }

      const customText = selectedPromptKey === 'custom'
        ? (customPrompt || resolveCustomPromptText())
        : null;
      if (customText) {
        requestBody.customPrompt = customText;
      }
      requestBody.promptStyle = selectedPromptKey;

      const response = await fetch(AI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      const raw = await response.text();
      const contentType = response.headers.get('content-type') || '';
      const looksLikeHtml = contentType.includes('text/html') || raw.trimStart().startsWith('<!DOCTYPE html');

      if (looksLikeHtml) {
        throw new Error('AI service endpoint is misconfigured for this build. Set VITE_AI_ENDPOINT to your deployed API URL.');
      }

      let payload = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch (parseError) {
        console.error('Failed to parse AI response:', parseError, 'Raw response:', raw);
        // A gateway that never reached the function answers in plain text, not
        // JSON. That is a service being down, not a malformed payload, and
        // saying so is the difference between "try again later" and "this is
        // broken for me".
        if (response.status >= 502 && response.status <= 504) {
          throw new Error('The analysis service is unavailable right now. Please try again in a moment.');
        }
        if (!response.ok) {
          throw new Error(`Analysis service error (HTTP ${response.status}).`);
        }
        throw new Error('Invalid response from analysis service.');
      }

      if (!response.ok) {
        if (response.status === 403 && payload?.code === 'style_locked') {
          // If the client already considers this user premium, the server's Supabase
          // record is stale. Re-sync RC → Supabase so the next attempt succeeds.
          if (aiQuota?.tier === 'premium' && IS_RC_SUPPORTED && rcCustomerInfo && viewerId) {
            syncCustomerInfoToSupabase(viewerId, rcCustomerInfo);
            setToast('Subscription sync issue. Your Pro status is being refreshed, so please try again in a moment.');
          } else {
            setToast('That insight style is locked. Upgrade to Pro in Settings to unlock all styles and custom prompts.');
          }
          return;
        }
        if (response.status === 429 && payload?.code === 'quota_exceeded') {
          setAiQuota(prev => ({ ...prev, remainingFree: 0, creditBalance: payload.creditBalance ?? 0 }));
          setToast('Monthly limit reached. Upgrade or buy credits in Settings to keep analyzing.');
          return;
        }
        throw new Error(payload?.error || `Analysis service error (HTTP ${response.status})`);
      }

      if (payload?.remainingFree !== undefined || payload?.creditBalance !== undefined) {
        setAiQuota({
          tier: payload.tier || 'free',
          remainingFree: payload.remainingFree ?? null,
          creditBalance: payload.creditBalance ?? 0,
        });
      }

      const generatedTitle = payload?.title?.trim() || '';
      const generatedInsights = (payload?.themes || payload?.summary || payload?.insights || '').trim();
      const sanitized = sanitizeAiGeneratedContent({ title: generatedTitle, insights: generatedInsights });
      const updates = { aiGenerated: true };

      if (sanitized.title) {
        updates.aiTitle = sanitized.title;
        if (!dream.title?.trim()) {
          updates.title = sanitized.title;
        }
      }

      if (sanitized.insights) {
        updates.aiInsights = sanitized.insights;
      }

      // Only save connections on the first analysis, because once a dream is memory-indexed,
      // re-generations keep the original pattern recognition so counts don't drift.
      if (!dream.memoryIndexed) {
        const rawConnections = Array.isArray(payload?.connections) ? payload.connections : [];
        if (rawConnections.length > 0) {
          updates.aiConnections = rawConnections;
        }
        updates.memoryIndexed = true;
      }

      if (!sanitized.title || !sanitized.insights) {
        throw new Error('AI response was incomplete.');
      }

      const dbUpdates = {};
      if (updates.aiGenerated !== undefined)    dbUpdates.ai_generated = updates.aiGenerated;
      if (updates.aiTitle !== undefined)        dbUpdates.ai_title = updates.aiTitle;
      if (updates.aiInsights !== undefined)     dbUpdates.ai_insights = updates.aiInsights;
      if (updates.aiConnections !== undefined)  dbUpdates.ai_connections = updates.aiConnections;
      if (updates.title !== undefined)          dbUpdates.title = updates.title;

      const { error: saveErr } = await supabase.from('dreams').update(dbUpdates).eq('id', dream.id);
      if (saveErr) throw saveErr;

      setDream(prev => ({ ...prev, ...updates }));
      setToast(sanitized.wasFiltered
        ? 'AI analysis was safety-filtered for 13+ audience and updated.'
        : 'Title and analysis updated.');
    } catch (err) {
      // fetch rejects with a TypeError when the request never got a response at
      // all: no network, DNS failure, connection refused. `err.message` there
      // is "Failed to fetch", which tells the user nothing.
      const isNetworkFailure = err instanceof TypeError;
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (isOffline) {
        setToast('You appear to be offline. Reconnect and try again.');
      } else if (isNetworkFailure) {
        setToast('Could not reach the analysis service. Please try again in a moment.');
      } else {
        setToast(err.message || 'Analysis generation failed.');
      }
    } finally {
      setAnalyzing(false);
    }
  };

  const handleReanalyze = async (promptKey) => {
    if (!dream || !isOwner) return;

    setReanalyzing(true);
    setPromptSelectorOpen(false);
    setToast(null);

    try {
      let customPrompt = null;
      let selectedPromptKey = normalizePromptKey(promptKey || 'balanced');

      if (promptKey === 'current') {
        selectedPromptKey = normalizePromptKey((userSettings?.aiPromptPreset || '').trim() || 'balanced');
        customPrompt = resolveCustomPromptText();
      } else if (promptKey === 'custom') {
        selectedPromptKey = 'custom';
        customPrompt = (userSettings?.aiPromptCustom || '').trim() || null;
      }

      if (isPromptLockedForTier(aiQuota?.tier || 'free', selectedPromptKey)) {
        setToast('That style is locked on the free plan. Upgrade in Settings to unlock it.');
        return;
      }

      await handleAnalyzeDream({ customPrompt, promptKey: selectedPromptKey });
    } finally {
      setReanalyzing(false);
    }
  };

  const handleApplyAiTitle = async () => {
    if (!dream?.aiTitle || !isOwner) return;
    setApplyingAiTitle(true);
    setToast(null);
    try {
      const { error } = await supabase.from('dreams').update({ title: dream.aiTitle }).eq('id', dream.id);
      if (error) throw error;
      setDream(prev => ({ ...prev, title: dream.aiTitle }));
      setTitleInput(dream.aiTitle);
      setToast('Title updated from AI suggestion.');
    } catch {
      setToast('Could not apply AI title.');
    } finally {
      setApplyingAiTitle(false);
    }
  };

  const handleDelete = () => {
    if (!dream || !isOwner || dream.id.startsWith('local-')) return;
    setConfirmModal({ action: 'deleteDream' });
  };

  const executeDeleteDream = async () => {
    setConfirmModal(null);
    setDeleting(true);
    try {
      const { error } = await supabase.from('dreams').delete().eq('id', dream.id);
      if (error) throw error;
      navigate('/journal');
    } catch {
      setError('Failed to delete this dream.');
      setDeleting(false);
    }
  };

  const submitSafetyReport = useCallback(async ({ targetType, targetId, targetUserId, reason, details }) => {
    if (!viewerId) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const idToken = sessionData?.session?.access_token;
    if (!idToken) throw new Error('Please sign in again before reporting.');

    const response = await fetch(ACCOUNT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({
        action: 'report_content',
        uid: viewerId,
        targetType,
        targetId,
        targetUserId: targetUserId || null,
        reason,
        details: details || ''
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.success) {
      throw new Error(payload?.error || 'Could not submit report.');
    }
  }, [viewerId, user]);

  const closeReportModal = useCallback(() => {
    setReportModal(null);
    setReportReason('');
  }, []);

  useEscapeKey(closeReportModal, Boolean(reportModal));

  const appendDictation = useCallback((text) => {
    setContentInput((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${text}` : text));
  }, []);

  const closePromptSelectors = useCallback(() => {
    setPromptSelectorOpen(false);
    setFirstAnalysisPromptSelector(false);
  }, []);

  useEscapeKey(closePromptSelectors, promptSelectorOpen || firstAnalysisPromptSelector);

  // Same dismissal rules as the feed's post menu: anywhere outside closes it.
  useEffect(() => {
    if (!authorMenuOpen) return undefined;
    const closeOnOutside = (event) => {
      if (!authorMenuRef.current?.contains(event.target)) setAuthorMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [authorMenuOpen]);

  useEscapeKey(() => setAuthorMenuOpen(false), authorMenuOpen);

  const handleReportDream = useCallback(() => {
    if (!dream?.id || !viewerId) return;
    setReportReason('');
    setReportModal({ targetType: 'dream', targetId: dream.id, targetUserId: dream.userId });
  }, [dream, viewerId]);

  const handleReportComment = useCallback((entry) => {
    if (!entry?.id || !viewerId) return;
    setReportReason('');
    setReportModal({ targetType: 'comment', targetId: entry.id, targetUserId: entry.userId, commentEntry: entry });
  }, [viewerId]);

  const handleSubmitReport = useCallback(async () => {
    if (!reportModal || !reportReason.trim()) return;
    setReportBusy(true);
    try {
      await submitSafetyReport({
        targetType: reportModal.targetType,
        targetId: reportModal.targetId,
        targetUserId: reportModal.targetUserId,
        reason: reportReason.trim(),
        details: reportModal.targetType === 'comment'
          ? `Reported comment on dream ${dream?.id || 'unknown'}`
          : `Reported from dream detail at ${new Date().toISOString()}`,
      });
      setReportModal(null);
      setReportReason('');
      if (reportModal.targetType === 'comment') {
        void triggerSuccessHaptic();
        setCommentStatus('Report submitted. We review safety reports within 24 hours.');
      } else {
        setToast('Report submitted. We review safety reports within 24 hours.');
      }
    } catch (reportError) {
      setToast(reportError.message || 'Could not submit report.');
    } finally {
      setReportBusy(false);
    }
  }, [reportModal, reportReason, submitSafetyReport, dream?.id]);

  const handleBlockAuthor = useCallback(async () => {
    if (!viewerId || !dream?.userId || dream.userId === viewerId) return;
    try {
      const currentSettings = userSettings || {};
      const currentBlocked = Array.isArray(currentSettings.blockedUserIds) ? currentSettings.blockedUserIds : [];
      const nextBlocked = [...new Set([...currentBlocked, dream.userId])];
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ settings: { ...currentSettings, blockedUserIds: nextBlocked } })
        .eq('id', viewerId);
      if (updateError) throw updateError;
      setUserSettings((prev) => ({ ...(prev || {}), blockedUserIds: nextBlocked }));
      setToast('User blocked. Their content is now hidden from your feed.');
      navigate('/feed');
    } catch {
      setToast('Could not block this user right now.');
    }
  }, [viewerId, dream?.userId, userSettings, navigate]);

  const renderCommentCard = (entry, depth = 0) => {
    const canRemove = isOwner || entry.userId === viewerId;
    const relativeTime = entry.createdAt ? formatDistanceToNow(entry.createdAt, { addSuffix: true }) : 'Just now';
    const replyingTo = entry.parentCommentId ? commentLookup[entry.parentCommentId] : null;
    const viewerHearted = Boolean(entry.heartUserIds?.[viewerId]);
    const heartCount = entry.heartCount || 0;
    const heartDisabled = heartingCommentIds.has(entry.id);
    const commenter = userSummaries[entry.userId] || null;
    return (
      <div className={`comment-card${depth ? ' comment-card-reply' : ''}`}>
        <div className="comment-meta">
          <div className="comment-meta-identity">
            <AvatarDisplay
              photoURL={commenter?.photoURL || null}
              avatarIcon={commenter?.avatarIcon}
              avatarBackground={commenter?.avatarBackground || DEFAULT_AVATAR_BACKGROUND}
              avatarColor={commenter?.avatarColor || DEFAULT_AVATAR_COLOR}
              className="comment-avatar"
            />
            <div className="comment-meta-names">
              <span className="comment-author">{entry.authorDisplayName || 'Dreamer'}</span>
              {entry.authorUsername && <span className="comment-handle">@{entry.authorUsername}</span>}
            </div>
          </div>
          <span className="comment-time">{relativeTime}</span>
        </div>
        {replyingTo && (
          <p className="comment-reply-context">
            Replying to {replyingTo.authorUsername ? `@${replyingTo.authorUsername}` : replyingTo.authorDisplayName || 'this comment'}
          </p>
        )}
        <p className="comment-body">{entry.content || ''}</p>
        {(viewerId || canRemove) ? (
          <div className="comment-actions">
            {viewerId ? (
              <button
                type="button"
                className={`comment-heart-btn${viewerHearted ? ' active' : ''}`}
                onClick={(event) => {
                  if (consumeSuppressedClick(event)) return;
                  handleToggleCommentHeart(entry);
                }}
                disabled={heartDisabled}
                aria-pressed={viewerHearted}
                aria-label={viewerHearted ? 'Remove like from comment' : 'Like comment'}
                onMouseEnter={(event) => handleCommentHeartHoverStart(event, entry)}
                onMouseLeave={scheduleModalAutoClose}
                onTouchStart={(event) => handleCommentHeartTouchStart(event, entry)}
                onTouchEnd={handleTouchEndInteraction}
                onTouchCancel={handleTouchEndInteraction}
                onTouchMove={handleTouchMoveInteraction}
              >
                <FontAwesomeIcon icon={faHeart} />
                <span className="comment-heart-count">{heartCount}</span>
              </button>
            ) : <span />}
            <div className="comment-action-links">
              {viewerId ? (
                <button
                  type="button"
                  className="comment-reply-btn"
                  onClick={() => handleReplyToComment(entry)}
                >
                  Reply
                </button>
              ) : null}
              {viewerId && entry.userId !== viewerId ? (
                <button
                  type="button"
                  className="comment-report-btn"
                  onClick={() => handleReportComment(entry)}
                >
                  Report
                </button>
              ) : null}
              {canRemove && (
                <button
                  type="button"
                  className="comment-delete-btn"
                  onClick={() => handleDeleteComment(entry.id, entry.userId)}
                  disabled={removingCommentId === entry.id}
                >
                  {removingCommentId === entry.id ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const renderCommentThread = (entry, depth = 0) => {
    const hasReplies = Array.isArray(entry.replies) && entry.replies.length > 0;
    if (depth === 0) {
      const isExpanded = expandedThreads[entry.id];
      return (
        <div key={entry.id} className="comment-thread">
          {renderCommentCard(entry, depth)}
          {hasReplies && (
            <>
              <button
                type="button"
                className="comment-replies-toggle"
                onClick={() => toggleThreadVisibility(entry.id)}
              >
                {isExpanded ? 'Hide replies' : `View replies (${entry.replies.length})`}
              </button>
              {isExpanded && (
                <div className="comment-thread-children">
                  {entry.replies.map((child) => renderCommentThread(child, depth + 1))}
                </div>
              )}
            </>
          )}
        </div>
      );
    }

    return (
      <div key={entry.id} className="comment-thread nested">
        {renderCommentCard(entry, depth)}
        {hasReplies && (
          <div className="comment-thread-children">
            {entry.replies.map((child) => renderCommentThread(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className={containerClass}>
        <DreamDetailSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className={containerClass}>
        {!isNativeIOS && (
          <button className="detail-back-btn" type="button" onClick={goBack}>
            <span className="detail-back-icon" aria-hidden="true">&larr;</span>
            <span>Go back</span>
          </button>
        )}
        <div className="detail-error">{error}</div>
      </div>
    );
  }

  if (!dream) {
    return (
      <div className={containerClass}>
        {!isNativeIOS && (
          <button className="detail-back-btn" type="button" onClick={goBack}>
            <span className="detail-back-icon" aria-hidden="true">&larr;</span>
            <span>Go back</span>
          </button>
        )}
        <div className="detail-error">Dream not available.</div>
      </div>
    );
  }

  const titleText = dream.title?.trim() || (dream.aiGenerated && dream.aiTitle) || 'Untitled dream';
  const dreamOwnerUsernameForDisplay = dream.visibility === 'anonymous' ? '' : (authorProfile?.username || '');
  // An anonymous dream shows no author, but it still has to be reportable, so
  // the actions row renders either way and only the identity half is gated.
  const showAuthorIdentity = Boolean(dream.visibility !== 'anonymous' && authorProfile);
  const hasAudienceQuery = audienceQuery.trim().length > 0;
  const commentCountLabel = comments.length ? ` (${comments.length})` : '';
  const visibilitySummary = visibilityLabel(dream.visibility);
  const aiLockedByQuota = aiQuota?.remainingFree === 0 && aiQuota?.creditBalance === 0;
  // The style saved in Settings leads the list rather than sitting in a separate
  // button above it. Picking it routes through 'current' so it still resolves
  // the exact prompt from settings, custom text included.
  //
  // Plainly computed, NOT useMemo: this sits below the loading/error/!dream
  // early returns, so a hook here would be skipped on the loading render and
  // run on the next one, because the hook count changes and react throws mid render.
  // It is a handful of array operations over nine items; there is nothing to
  // memoise anyway.
  const promptOptions = (() => {
    const preset = (userSettings?.aiPromptPreset || '').trim();
    const usesCustom = preset === 'custom' && Boolean(userSettings?.aiPromptCustom);
    // A 'custom' preset with nothing saved in it resolves to balanced on the
    // server, so mark balanced rather than leaving the list with no default.
    const currentKey = resolveCurrentPromptKey();
    const all = Object.keys(PROMPT_LABELS)
      .filter((key) => key !== 'custom')
      .map((key) => ({ key, label: PROMPT_LABELS[key] || key }));
    if (usesCustom) all.push({ key: 'custom', label: 'My custom prompt' });
    const decorated = all.map((option) => ({ ...option, isCurrent: option.key === currentKey }));
    return [...decorated.filter((o) => o.isCurrent), ...decorated.filter((o) => !o.isCurrent)];
  })();

  /**
   * The style list plus its confirm row.
   *
   * Picking a style no longer fires the request. It selects that style and
   * opens its description, one at a time so the panel never becomes a wall of
   * text, and the run only happens when the user confirms. Choosing and acting
   * were the same click before, which meant reading what a style actually does
   * required running it.
   */
  const renderPromptChooser = ({ confirmLabel, onConfirm, onCancel, busy }) => {
    const selected = promptOptions.find((option) => option.key === selectedPrompt) || null;
    return (
      <>
        <div className="prompt-options-list">
          {promptOptions.map((option) => {
            const locked = isOptionLocked(option.key);
            const isSelected = selectedPrompt === option.key;
            return (
              <button
                key={option.key}
                type="button"
                className={`prompt-option-btn${option.isCurrent ? ' current-prompt' : ''}${locked ? ' locked' : ''}${isSelected ? ' is-selected' : ''}`}
                onClick={() => { if (!locked) setSelectedPrompt(isSelected ? null : option.key); }}
                disabled={busy || locked}
                aria-pressed={isSelected}
                title={locked ? 'Upgrade to Pro to unlock this style' : undefined}
              >
                <span className="prompt-option-head">
                  {locked && <FontAwesomeIcon icon={faLock} className="prompt-lock-icon" />}
                  <span className="prompt-option-label">{option.label}</span>
                  {option.isCurrent && <span className="prompt-current-tag">Your setting</span>}
                  {locked && <span className="prompt-pro-badge">Pro</span>}
                </span>
                <span className="prompt-option-desc">
                  <span>{PROMPT_DESCRIPTIONS[option.key] || ''}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="prompt-selector-actions">
          <button type="button" className="ghost-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={() => { if (selected) onConfirm(selected); }}
            disabled={busy || !selected}
          >
            {confirmLabel}
          </button>
        </div>
      </>
    );
  };

  const isOptionLocked = (key) => (
    key === 'custom'
      ? (aiQuota?.tier || 'free') !== 'premium'
      : isPromptLockedForTier(aiQuota?.tier || 'free', key)
  );

  return (
    <div className={containerClass}>
      <div className="detail-card">
        {!isNativeIOS && (
          <div className="detail-toolbar">
            <button
              type="button"
              className="detail-back-btn"
              onClick={goBack}
            >
              <span className="detail-back-icon" aria-hidden="true">&larr;</span>
              <span>Go back</span>
            </button>
          </div>
        )}
        <div className="detail-head">
          <div className="detail-title-block">
            {isOwner ? (
              editingTitle ? (
                <div className="detail-title-edit">
                  <input
                    type="text"
                    className="detail-title-input"
                    placeholder="Enter a title"
                    value={titleInput}
                    onChange={(e) => setTitleInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleSaveTitle();
                      }
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={handleSaveTitle}
                    disabled={savingField === 'title'}
                  >
                    {savingField === 'title' ? 'Saving…' : 'Save'}
                  </button>
                  <button type="button" className="ghost-btn" onClick={() => setEditingTitle(false)}>Cancel</button>
                </div>
              ) : (
                <h1 className="detail-title">
                  <button
                    type="button"
                    className="detail-title-editable"
                    onClick={() => setEditingTitle(true)}
                  >
                    {titleText} <span className="edit-hint">✎</span>
                  </button>
                </h1>
              )
            ) : (
              <h1 className="detail-title">{titleText}</h1>
            )}
          </div>
          <div className="detail-date-block">
            {isOwner && editingDate ? (
              <div className="detail-date-edit detail-date-edit--standalone">
                <input
                  type="date"
                  className="detail-date-input"
                  aria-label="Dream date"
                  value={dateInput}
                  onChange={(e) => setDateInput(e.target.value)}
                />
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={handleSaveDate}
                  disabled={savingField === 'date'}
                >
                  {savingField === 'date' ? 'Saving…' : 'Save'}
                </button>
                <button type="button" className="ghost-btn" onClick={() => setEditingDate(false)}>Cancel</button>
              </div>
            ) : formattedDate ? (
              isOwner ? (
                <button
                  type="button"
                  className="detail-date-pill detail-date-pill--interactive"
                  onClick={() => setEditingDate(true)}
                >
                  {formattedDate}
                  <span className="edit-hint">✎</span>
                </button>
              ) : (
                <div className="detail-date-pill">{formattedDate}</div>
              )
            ) : null}
            {isOwner && !editingContent && (
              <button
                type="button"
                className="ghost-btn ghost-btn--compact detail-edit-content-btn"
                onClick={() => {
                  setEditingContent(true);
                  setContentInput(dream.content || '');
                  setEditableTags(Array.isArray(dream.tags) ? dream.tags : []);
                }}
              >
                Edit content
              </button>
            )}
          </div>
        </div>

        {!isOwner && (showAuthorIdentity || viewerId) && (
          <div className="detail-author-block">
            {showAuthorIdentity && (
              <button
                type="button"
                className="detail-author-btn"
                onClick={() => navigate(buildProfilePath(authorProfile.username, authorProfile.id))}
              >
                <AvatarDisplay
                  photoURL={authorProfile.photoURL || null}
                  avatarIcon={authorProfile.avatarIcon}
                  avatarBackground={authorProfile.avatarBackground || DEFAULT_AVATAR_BACKGROUND}
                  avatarColor={authorProfile.avatarColor || DEFAULT_AVATAR_COLOR}
                  className="detail-author-avatar"
                />
                <div className="detail-author-meta">
                  <span className="detail-author-name">
                    {authorProfile.displayName || 'Dreamer'}
                    <ProBadge subscription={authorProfile.subscription} />
                  </span>
                  {authorProfile.username && (
                    <span className="detail-author-handle">@{authorProfile.username}</span>
                  )}
                </div>
              </button>
            )}
            {viewerId && (
              <div className="overflow-menu-root detail-author-menu" ref={authorMenuRef}>
                <button
                  type="button"
                  className="overflow-menu-btn"
                  aria-label="Dream actions"
                  aria-haspopup="menu"
                  aria-expanded={authorMenuOpen}
                  onClick={() => setAuthorMenuOpen((open) => !open)}
                >
                  <FontAwesomeIcon icon={faEllipsisVertical} />
                </button>
                {authorMenuOpen && (
                  <div className="overflow-menu" role="menu" aria-label="Dream actions">
                    {showAuthorIdentity && dream.userId && (
                      <button
                        type="button"
                        className="overflow-menu-item"
                        role="menuitem"
                        onClick={() => { setAuthorMenuOpen(false); handleBlockAuthor(); }}
                      >
                        Block user
                      </button>
                    )}
                    <button
                      type="button"
                      className="overflow-menu-item overflow-menu-item-danger"
                      role="menuitem"
                      onClick={() => { setAuthorMenuOpen(false); handleReportDream(); }}
                    >
                      Report dream
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="detail-body">
            {isOwner && editingContent ? (
              <>
                <VoiceField>
                  <textarea
                    className="detail-textarea"
                    aria-label="Dream text"
                    value={contentInput}
                    onChange={(e) => setContentInput(e.target.value)}
                  />
                  <div className="voice-field-affordance">
                    <VoiceInput
                      onTranscript={appendDictation}
                      onNotice={setToast}
                      label="Dictate your dream"
                    />
                  </div>
                </VoiceField>
                <div className="detail-tags-editor">
                  <label htmlFor="detail-tag-input">Tags</label>
                  <div className="detail-tag-input-row">
                    <input
                      id="detail-tag-input"
                      type="text"
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddTag();
                        }
                      }}
                      placeholder="Add a tag"
                    />
                    <button type="button" className="add-tag-btn" onClick={handleAddTag}>+ Tag</button>
                  </div>
                  {editableTags.length ? (
                    <div className="detail-tag-list">
                      {editableTags.map((tag) => (
                        <span className="detail-tag-chip" key={`edit-tag-${tag.value}`}>
                          {tag.value}
                          <button type="button" className="detail-tag-remove" onClick={() => handleRemoveTag(tag.value)} aria-label={`Remove tag ${tag.value}`}>
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="detail-edit-actions">
                  <button type="button" className="ghost-btn" onClick={handleCancelContentEdit}>Cancel</button>
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={handleSaveContent}
                    disabled={!contentInput.trim() || savingField === 'content'}
                  >
                    {savingField === 'content' ? 'Saving changes…' : 'Save changes'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>{dream.content}</p>
                {dream.tags?.length ? (
                  <div className="detail-tags detail-tags-inline">
                    {dream.tags.map((tag, index) => (
                      <span className="tag" key={`${dream.id}-tag-${index}`}>{tag.value}</span>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>

        {dream.visibility !== 'private' && <div className="activity-reactions detail-reactions" aria-label="Dream reactions">
          <div className="reaction-buttons">
            <button
              type="button"
              className={`reaction-button reaction-button--heart${viewerHeartedDream ? ' active' : ''}`}
              onClick={(event) => {
                if (consumeSuppressedClick(event)) return;
                handleDreamReactionSelection(DEFAULT_EMOJI);
              }}
              aria-pressed={viewerHeartedDream}
              aria-label={viewerHeartedDream ? 'Remove your heart' : 'React with a heart'}
            >
              <FontAwesomeIcon icon={faHeart} className="reaction-icon" />
              <span className="reaction-count">{reactionSnapshot.counts?.[DEFAULT_EMOJI] || 0}</span>
            </button>
            <button
              type="button"
              className="reaction-button reaction-button--comment"
              onClick={handleJumpToComposer}
              aria-label="Write a comment"
            >
              <FontAwesomeIcon icon={faComment} className="reaction-icon" />
              <span className="reaction-count">{comments.length}</span>
            </button>
            {emojiReactionEntries.map(([emoji, count]) => {
              const reacted = viewerDreamReactions.includes(emoji);
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`reaction-button reaction-button--emoji${reacted ? ' active' : ''}`}
                  onClick={(event) => {
                    if (consumeSuppressedClick(event)) return;
                    handleDreamReactionSelection(emoji);
                  }}
                  aria-pressed={reacted}
                  aria-label={reacted ? `Remove your ${emoji} reaction` : `React with ${emoji}`}
                >
                  <span className="reaction-emoji-text" aria-hidden="true">{emoji}</span>
                  <span className="reaction-count">{count}</span>
                </button>
              );
            })}
            <button
              type="button"
              className="reaction-button custom-emoji-trigger"
              onClick={openCustomEmojiPicker}
              aria-label="Add emoji reaction"
            >
              <FontAwesomeIcon icon={faPlus} className="reaction-icon" />
            </button>
          </div>
          {customEmojiPickerOpen && (
            <div className="custom-emoji-popover">
              <div className="emoji-picker-grid" role="listbox" aria-label="Emoji suggestions">
                {COMMON_EMOJI_REACTIONS.map((emoji) => (
                  <button
                    key={`picker-${emoji}`}
                    type="button"
                    className={`emoji-option${reactionSnapshot.viewerReactions?.includes(emoji) ? ' selected' : ''}`}
                    onClick={() => handleDreamReactionSelection(emoji)}
                  >
                    <span aria-hidden="true">{emoji}</span>
                    <span className="sr-only">React with {emoji}</span>
                  </button>
                ))}
              </div>
              <form className="emoji-input-row" onSubmit={handleCustomEmojiSubmit}>
                <input
                  type="text"
                  ref={emojiInputRef}
                  inputMode="text"
                  enterKeyHint="done"
                  autoComplete="off"
                  maxLength={4}
                  value={customEmojiValue}
                  onChange={(event) => handleCustomEmojiChange(event.target.value)}
                  aria-label="Type an emoji"
                  placeholder="Type or paste an emoji"
                  autoFocus
                />
                <button type="submit" className="primary-btn" disabled={!filterEmojiInput(customEmojiValue)}>
                  Add
                </button>
                <button type="button" className="ghost-btn" onClick={closeCustomEmojiPicker}>
                  Cancel
                </button>
              </form>
              {reactionSnapshot.viewerReactions?.some((e) => e !== DEFAULT_EMOJI) && (
                <button type="button" className="emoji-clear-btn" onClick={() => { handleDreamReactionSelection(reactionSnapshot.viewerReactions.find((e) => e !== DEFAULT_EMOJI)); closeCustomEmojiPicker(); }}>
                  Clear reaction
                </button>
              )}
            </div>
          )}
        </div>}


        <div className="detail-summary">
            <div className="detail-summary-text">
              <h3>Analysis</h3>
              {analyzing || reanalyzing ? (
                <div className="analysis-pending" role="status" aria-live="polite">
                  <span className="analysis-pending-line" />
                  <span className="analysis-pending-line" />
                  <span className="analysis-pending-line" />
                  <p className="analysis-pending-note">
                    <span className="inline-spinner" aria-hidden="true" />
                    Reading your dream and looking for patterns…
                  </p>
                </div>
              ) : dream.aiGenerated && dream.aiInsights ? (
                <>
                  <p className="detail-insight">{dream.aiInsights}</p>
                  {isOwner && Array.isArray(dream.aiConnections) && dream.aiConnections.length > 0 && (
                    <div className="detail-connections">
                      <p className="detail-connections-label">Pattern recognition</p>
                      <ul className="detail-connections-list">
                        {dream.aiConnections.map((c, i) => (
                          <li key={i} className="detail-connections-item">{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p className="ai-privacy-notice">🔒 Your dreams stay private. This analysis is not used for AI training and is deleted based on your privacy settings. <br/>AI insights are for reflection only and may be inaccurate. Do not use them as medical, mental health, legal, or safety advice.</p>
                </>
              ) : (
                <p className="detail-insight muted">No analysis yet.</p>
              )}
            </div>
            {isOwner && (
              <div className="detail-summary-footer">
                <div className="detail-summary-controls">
                  {aiQuota && (
                    <p className="ai-quota-badge">
                      {aiQuota.tier === 'premium'
                        ? aiQuota.remainingFree > 0
                          ? `${aiQuota.remainingFree} of 30 Pro analyses left this cycle`
                          : aiQuota.creditBalance > 0
                            ? `${aiQuota.creditBalance} paid AI credit${aiQuota.creditBalance === 1 ? '' : 's'} remaining`
                            : 'Pro monthly limit reached'
                        : aiQuota.remainingFree > 0
                          ? `${aiQuota.remainingFree} of 1 free analysis left`
                          : aiQuota.creditBalance > 0
                            ? `${aiQuota.creditBalance} paid AI credit${aiQuota.creditBalance === 1 ? '' : 's'} remaining`
                            : 'Monthly limit reached'}
                    </p>
                  )}
                  {!dream.aiGenerated && firstAnalysisPromptSelector ? (
                    <div className="prompt-selector-modal">
                      <div className="prompt-selector-content">
                        <h3>Choose an insight style</h3>
                        <p className="prompt-selector-hint">You can change this anytime in Settings</p>
                        {renderPromptChooser({
                          confirmLabel: 'Generate',
                          busy: analyzing,
                          onCancel: () => setFirstAnalysisPromptSelector(false),
                          onConfirm: (option) => {
                            setFirstAnalysisPromptSelector(false);
                            if (option.isCurrent) handleAnalyzeDream({ skipPromptSelector: true });
                            else handleReanalyze(option.key);
                          },
                        })}
                      </div>
                    </div>
                  ) : null}
                  {!dream.aiGenerated && !firstAnalysisPromptSelector ? (
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={() => handleAnalyzeDream()}
                      disabled={analyzing || aiLockedByQuota}
                    >
                      {analyzing
                        ? <span className="btn-loading"><span className="inline-spinner" aria-hidden="true" />Generating…</span>
                        : 'Generate title & analysis'}
                    </button>
                  ) : null}
                  {dream.aiGenerated ? (
                    <div className="reanalyze-controls">
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => {
                          if (!promptSelectorOpen) setSelectedPrompt(resolveCurrentPromptKey());
                          setPromptSelectorOpen(!promptSelectorOpen);
                        }}
                        disabled={reanalyzing || analyzing || aiLockedByQuota}
                      >
                        {reanalyzing
                          ? <span className="btn-loading"><span className="inline-spinner" aria-hidden="true" />Regenerating…</span>
                          : 'Regenerate with different prompt'}
                      </button>
                      {promptSelectorOpen && (
                        <div className="prompt-selector-panel">
                          <p className="prompt-selector-label">Choose an insight style</p>
                          {renderPromptChooser({
                            confirmLabel: 'Regenerate',
                            busy: reanalyzing,
                            onCancel: () => setPromptSelectorOpen(false),
                            onConfirm: (option) => {
                              setPromptSelectorOpen(false);
                              handleReanalyze(option.isCurrent ? 'current' : option.key);
                            },
                          })}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
                {aiQuota && aiQuota.tier !== 'premium' && accountTier === 'free' && (
                  <div className="ai-upgrade-cta">
                    <p>Unlock all insight styles, custom instructions, and cross-dream pattern analysis with Pro.</p>
                    <div className="ai-upgrade-cta-actions">
                      <button type="button" className="ghost-btn" onClick={() => navigate('/settings')}>Subscribe to Pro</button>
                      <button type="button" className="ghost-btn" onClick={() => navigate('/settings')}>Buy AI credits</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

        {isOwner && dream.aiGenerated && dream.aiTitle && dream.aiTitle !== (dream.title || '').trim() ? (
          <div className="ai-title-hint">
            <p className="ai-title-label">AI suggestion: <span>{dream.aiTitle}</span></p>
            <button
              type="button"
              className="ghost-btn"
              style={{ marginTop: '0.5rem' }}
              onClick={handleApplyAiTitle}
              disabled={applyingAiTitle}
            >
              {applyingAiTitle ? 'Applying…' : 'Use AI title'}
            </button>
          </div>
        ) : null}

        {dream.visibility !== 'private' && <div className="detail-comments" ref={commentsSectionRef}>
          <div className="detail-section-head">
            <p className="detail-label">Comments{commentCountLabel}</p>
          </div>
          {viewerId ? (
            <div className="comment-composer">
              {replyTarget && (
                <div className="reply-context">
                  <span>
                    Replying to {replyTarget.authorUsername ? `@${replyTarget.authorUsername}` : replyTarget.authorDisplayName}
                  </span>
                  <button type="button" className="reply-cancel-btn" onClick={clearReplyTarget}>
                    Cancel
                  </button>
                </div>
              )}
              <textarea
                ref={commentInputRef}
                placeholder="Add a thoughtful note"
                aria-label="Write a comment"
                value={commentInput}
                onChange={(e) => {
                  setCommentInput(e.target.value);
                  if (commentStatus) {
                    setCommentStatus('');
                  }
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    handleSubmitComment();
                  }
                }}
              />
              {composerEngaged && (
                <div className="comment-composer-actions">
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={handleSubmitComment}
                    disabled={commentBusy || !commentInput.trim()}
                  >
                    {commentBusy ? 'Posting…' : 'Post comment'}
                  </button>
                </div>
              )}
              {commentStatus && <p className="detail-hint composer-status">{commentStatus}</p>}
            </div>
          ) : (
            <p className="detail-hint">Sign in to add your take.</p>
          )}
          {commentsLoading ? (
            <div className="loading-inline">
              <LoadingIndicator label="Loading comments…" size="sm" align="start" />
            </div>
          ) : commentError ? (
            <p className="detail-hint">{commentError}</p>
          ) : commentThreads.length ? (
            <div className="comments-list">
              {commentThreads.map((entry) => renderCommentThread(entry))}
            </div>
          ) : (
            <p className="detail-hint">No comments yet. Be the first to add one.</p>
          )}
        </div>}

        {isOwner && (
          <div className="detail-share-accordion">
            <button
              type="button"
              className="detail-share-toggle"
              onClick={() => setSharingControlsOpen((prev) => !prev)}
              aria-expanded={sharingControlsOpen}
            >
              <div>
                <p className="detail-label">Sharing options</p>
                <p className="detail-hint">{visibilitySummary}</p>
              </div>
              <span className={`share-toggle-icon${sharingControlsOpen ? ' open' : ''}`} aria-hidden="true">
                <FontAwesomeIcon icon={faChevronDown} />
              </span>
            </button>
            {sharingControlsOpen && (
              <div className="detail-share-panel">
                <div className="detail-visibility">
                  <p className="detail-label">Visibility</p>
                  <div className="detail-visibility-options">
                    {VISIBILITY_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={(dream.visibility === option.value || (option.value === 'mutuals' && dream.visibility === 'following')) ? 'pill pill-active' : 'pill'}
                        onClick={() => handleVisibilityChange(option.value)}
                        aria-pressed={dream.visibility === option.value || (option.value === 'mutuals' && dream.visibility === 'following')}
                        disabled={updatingVisibility}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                {dream.visibility !== 'private' && (
                  <div className="detail-audience">
                    <div className="detail-section-head">
                      <p className="detail-label">Hide from specific people</p>
                      <p className="detail-hint">Search your following to keep certain dreamers from seeing this entry.</p>
                    </div>
                    {audienceLoading ? (
                      <div className="loading-inline">
                        <LoadingIndicator label="Loading your following…" size="sm" align="start" />
                      </div>
                    ) : audienceOptions.length === 0 ? (
                      <p className="detail-hint">Follow people to curate this list.</p>
                    ) : (
                      <>
                        <div className="audience-search-input">
                          <input
                            type="text"
                            placeholder="Search your following"
                            aria-label="Search your following"
                            value={audienceQuery}
                            onChange={(e) => setAudienceQuery(e.target.value)}
                          />
                        </div>
                        {!hasAudienceQuery ? (
                          <p className="detail-hint">Start typing to search your following.</p>
                        ) : (
                          <div className="audience-result-list">
                            {filteredAudience.length ? (
                              filteredAudience.map((profile) => {
                                const isHidden = excludedViewerIds.includes(profile.id);
                                return (
                                  <button
                                    key={profile.id}
                                    type="button"
                                    className={`audience-result${isHidden ? ' active' : ''}`}
                                    onClick={() => handleToggleAudience(profile.id)}
                                    disabled={audienceBusy}
                                  >
                                    <div className="audience-result-meta">
                                      <span className="result-name">{profile.displayName}</span>
                                      {profile.username && <span className="result-handle">@{profile.username}</span>}
                                    </div>
                                    <span className="result-status">{isHidden ? 'Hidden' : 'Visible'}</span>
                                  </button>
                                );
                              })
                            ) : (
                              <p className="detail-hint">
                                No matches for &ldquo;{audienceQuery}&rdquo;.
                              </p>
                            )}
                          </div>
                        )}
                        {excludedViewerIds.length > 0 && (
                          <div className="selected-pill-row">
                            {excludedViewerIds.map((id) => {
                              const profile = audienceLookup[id];
                              const label = profile?.username ? `@${profile.username}` : profile?.displayName || 'Dreamer';
                              return (
                                <span key={id} className="selected-pill">
                                  {label}
                                  <button
                                    type="button"
                                    onClick={() => handleToggleAudience(id)}
                                    aria-label={`Remove ${label}`}
                                    disabled={audienceBusy}
                                  >
                                    ×
                                  </button>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                    {audienceBusy && <p className="detail-hint">Updating…</p>}
                  </div>
                )}

                <div className="detail-tagged">
                  <p className="detail-label">Tag people</p>
                  <div className="tag-people-input">
                    <input
                      type="text"
                      placeholder="@username"
                      aria-label="Tag a dreamer by username"
                      value={tagHandle}
                      onChange={(e) => {
                        setTagHandle(e.target.value);
                        setTaggingStatus('');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddTaggedPerson();
                        }
                      }}
                    />
                    <button type="button" className="add-tag-btn" onClick={handleAddTaggedPerson} disabled={taggingBusy || !tagHandle.trim()}>
                      {taggingBusy ? 'Tagging…' : 'Tag'}
                    </button>
                  </div>
                  {tagSuggestions.length > 0 && (
                    <div className="tag-suggestion-list">
                      {tagSuggestions.map((profile) => (
                        <button
                          type="button"
                          key={profile.id}
                          className="tag-suggestion-item"
                          onClick={() => handleSelectTagSuggestion(profile)}
                          disabled={taggingBusy}
                        >
                          <span className="suggestion-name">{profile.displayName}</span>
                          {profile.username && <span className="suggestion-username">@{profile.username}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  {taggingStatus && <p className="detail-hint">{taggingStatus}</p>}
                  {taggedPeople.length ? (
                    <div className="tagged-pill-row">
                      {taggedPeople.map((entry) => (
                        <span key={entry.userId} className="tagged-pill">
                          @{entry.username || entry.displayName}
                          <button type="button" aria-label={`Remove ${entry.username || entry.displayName}`} onClick={() => handleRemoveTaggedPerson(entry.userId)} disabled={taggingBusy}>
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="detail-hint">
                      {dream?.visibility === 'private'
                        ? 'Tags are for your own record on this private dream.'
                        : 'Tagged dreamers will see this on their profile.'}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="detail-actions">
          <button type="button" className="secondary-btn" onClick={goBack}>
            Close
          </button>
          {isOwner && (
            <button
              type="button"
              className="danger-btn"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete dream'}
            </button>
          )}
        </div>
      </div>

      <ReactionInsightsModal
        open={reactionInsightState.open}
        anchorRect={reactionInsightState.anchorRect}
        title={reactionInsightState.title}
        subtitle={reactionInsightState.subtitle}
        emoji={reactionInsightState.emoji}
        entries={reactionInsightEntries}
      />

      {reportModal && (
        <Overlay>
        <div className="report-modal-backdrop" onClick={closeReportModal}>
          <div className="report-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Report {reportModal.targetType === 'comment' ? 'comment' : 'dream'}</h3>
            <p className="report-modal-desc">Select the reason that best describes the issue. Reports are reviewed within 24 hours.</p>
            <div className="report-reasons">
              {['Harassment or bullying', 'Hate speech', 'Sexual content', 'Violence', 'Spam', 'Other'].map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`report-reason-btn${reportReason === r ? ' selected' : ''}`}
                  onClick={() => setReportReason(r)}
                >
                  {r}
                </button>
              ))}
            </div>
            <div className="report-modal-actions">
              <button type="button" className="secondary-btn" onClick={closeReportModal}>Cancel</button>
              <button
                type="button"
                className="danger-btn"
                onClick={handleSubmitReport}
                disabled={!reportReason.trim() || reportBusy}
              >
                {reportBusy ? 'Submitting…' : 'Submit report'}
              </button>
            </div>
          </div>
        </div>
        </Overlay>
      )}

      {confirmModal?.action === 'deleteComment' && (
        <ConfirmModal
          title="Remove comment?"
          message="This comment will be permanently deleted."
          confirmLabel="Remove"
          danger
          onConfirm={() => executeDeleteComment(confirmModal.commentId)}
          onCancel={() => setConfirmModal(null)}
        />
      )}

      {confirmModal?.action === 'deleteDream' && (
        <ConfirmModal
          title="Delete dream?"
          message="This dream and all its comments will be permanently deleted. This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={executeDeleteDream}
          onCancel={() => setConfirmModal(null)}
        />
      )}

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} duration={5000} />}
    </div>
  );
}

DreamDetail.propTypes = {
  user: appUserPropType
};
