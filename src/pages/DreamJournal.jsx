import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import PropTypes from 'prop-types';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { supabase } from '../supabase';
import { mapDream, mapProfile } from '../utils/mappers';
import LoadingIndicator from '../components/LoadingIndicator';
import { JournalSkeleton } from '../components/SkeletonLoader';
import Toast from '../components/Toast';
import { formatDreamDate, getTodayDateInputValue, parseDateInputValue } from '../utils/dates';
import { buildDreamPath } from '../utils/urlHelpers';
import { triggerLightHaptic, triggerMediumHaptic, triggerSelectionHaptic, triggerSuccessHaptic, triggerErrorHaptic } from '../utils/haptics';
import { getModerationFeedback } from '../utils/contentModeration';
import { highlightSnippet } from '../utils/highlight';
import useEscapeKey from '../hooks/useEscapeKey';
import useRefreshSignal from '../hooks/useRefreshSignal';
import VoiceInput from '../components/VoiceInput';
import './DreamJournal.css';
import { appUserPropType } from '../propTypes';

const VISIBILITY_LABELS = {
  private: 'Private',
  public: 'Public',
  followers: 'Followers only',
  mutuals: 'Mutuals only',
  anonymous: 'Anonymous'
};

const VISIBILITY_OPTIONS = [
  { value: 'private',   label: 'Private',              helper: 'Only you can view this entry.' },
  { value: 'public',    label: 'Public',               helper: 'Appears on your profile and Following feed.' },
  { value: 'followers', label: 'Followers',            helper: 'Only people following you can view it.' },
  { value: 'mutuals',   label: 'Mutuals',              helper: 'Only people you follow back can view it.' },
  { value: 'anonymous', label: 'Anonymous',            helper: 'Shared publicly but your name and profile are hidden.' },
];

const CONTENT_PREVIEW_LIMIT = 240;

const CARD_VISIBILITY_LABELS = {
  private:   'Private',
  public:    'Public',
  followers: 'Followers',
  mutuals:   'Mutuals',
  anonymous: 'Anon',
};

const CALENDAR_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad2 = (value) => String(value).padStart(2, '0');

const formatDateKeyFromLocalDate = (date) => (
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
);

const monthPrefixFromDate = (date) => (
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-`
);

const monthLabel = (date) => (
  new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(date)
);

const dateLabel = (dateKey) => {
  const parsed = parseDateInputValue(dateKey);
  if (!parsed) return dateKey;
  return formatDreamDate(parsed, 'MMMM d, yyyy');
};

export default function DreamJournal({ user }) {
  const [dreams, setDreams] = useState([]);
  const [viewMode, setViewMode] = useState('list');
  const [showNewDream, setShowNewDream] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [dreamDate, setDreamDate] = useState(() => getTodayDateInputValue());
  const [visibility, setVisibility] = useState('private');
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [connectionOptions, setConnectionOptions] = useState([]);
  const [audienceLoading, setAudienceLoading] = useState(false);
  const [audienceQuery, setAudienceQuery] = useState('');
  const [excludedViewerIds, setExcludedViewerIds] = useState([]);
  const [taggedUsers, setTaggedUsers] = useState([]);
  const [tagHandle, setTagHandle] = useState('');
  const [taggingStatus, setTaggingStatus] = useState('');
  const [taggingBusy, setTaggingBusy] = useState(false);
  const [viewerProfile, setViewerProfile] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedCalendarDateKey, setSelectedCalendarDateKey] = useState(null);
  const [monthDirection, setMonthDirection] = useState('next');
  const formScrollRef = useRef(null);
  const [scrollEdge, setScrollEdge] = useState({ top: true, bottom: false });
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const navigate = useNavigate();
  const hasAudienceQuery = audienceQuery.trim().length > 0;

  // Lock body scroll while modal is open so only the modal itself scrolls
  useEffect(() => {
    if (showNewDream) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [showNewDream]);

  useRefreshSignal(useCallback(() => setRefreshKey((n) => n + 1), []));

  const checkScrollEdge = useCallback(() => {
    const el = formScrollRef.current;
    if (!el) return;
    const top = el.scrollTop <= 2;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    setScrollEdge((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  // Re-check edges whenever the modal opens (content may or may not overflow)
  useEffect(() => {
    if (showNewDream) {
      // Defer one frame so the form has rendered and scrollHeight is accurate
      const id = requestAnimationFrame(checkScrollEdge);
      return () => cancelAnimationFrame(id);
    }
  }, [showNewDream, checkScrollEdge]);

  useEffect(() => {
    if (!user?.uid) {
      setDreams([]);
      setConnectionOptions([]);
      setInitialLoading(false);
      return;
    }

    const fetchDreams = async () => {
      const { data, error } = await supabase
        .from('dreams')
        .select('*')
        .eq('user_id', user.uid)
        .order('created_at', { ascending: false });
      if (error) {
        setToast('Live sync failed. Check your connection.');
      } else {
        setDreams((data || []).map(mapDream));
      }
      setInitialLoading(false);
    };

    fetchDreams();

    const channel = supabase
      .channel(`journal:${user.uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dreams', filter: `user_id=eq.${user.uid}` },
        () => fetchDreams())
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [user?.uid, refreshKey]);

  useEffect(() => {
    if (!user?.uid) {
      setConnectionOptions([]);
      setAudienceLoading(false);
      return;
    }
    let cancelled = false;

    const loadFollowing = async () => {
      setAudienceLoading(true);
      try {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', user.uid)
          .single();
        const profile = profileData ? mapProfile(profileData) : null;
        if (!cancelled && profile) {
          setViewerProfile({ id: profile.id, username: profile.username, displayName: profile.displayName });
        }

        const connectionIds = [
          ...new Set([...(profile?.followingIds || []), ...(profile?.followerIds || [])])
        ].filter((id) => id && id !== user.uid);

        if (!connectionIds.length) {
          if (!cancelled) { setConnectionOptions([]); setAudienceQuery(''); }
          return;
        }

        const { data: profilesData } = await supabase
          .from('profiles')
          .select('id, display_name, username')
          .in('id', connectionIds);

        if (!cancelled) {
          setConnectionOptions((profilesData || []).map((r) => ({
            id: r.id,
            displayName: r.display_name || 'Dreamer',
            username: r.username || '',
          })));
          setAudienceQuery('');
        }
      } catch {
        if (!cancelled) { setConnectionOptions([]); setAudienceQuery(''); }
      } finally {
        if (!cancelled) setAudienceLoading(false);
      }
    };

    loadFollowing();
    return () => { cancelled = true; };
  }, [user?.uid]);

  const truncate = (text, limit) => {
    if (!text) return '';
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };

  const filteredDreams = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return dreams;
    const wordBound = searchQuery.endsWith(' ');
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = wordBound ? new RegExp(`\\b${escaped}\\b`, 'i') : null;
    const test = (text) => wordBound ? regex.test(text || '') : (text || '').toLowerCase().includes(q);
    return dreams.filter((d) => test(d.title || '') || test(d.content || '') || test(d.aiTitle || ''));
  }, [dreams, searchQuery]);

  const normalizeHandle = (value = '') => value.replace(/^@/, '').trim().toLowerCase();

  const tagSuggestions = useMemo(() => {
    const normalized = normalizeHandle(tagHandle);
    if (!normalized) return [];
    return connectionOptions
      .filter((profile) => {
        if (!profile?.id || profile.id === user?.uid) return false;
        if (taggedUsers.some((entry) => entry.userId === profile.id)) return false;
        const username = (profile.username || '').toLowerCase();
        const displayName = (profile.displayName || '').toLowerCase();
        return username.includes(normalized) || displayName.includes(normalized);
      })
      .slice(0, 5);
  }, [connectionOptions, tagHandle, taggedUsers, user?.uid]);

  const connectionLookup = useMemo(() => (
    connectionOptions.reduce((acc, p) => { acc[p.id] = p; return acc; }, {})
  ), [connectionOptions]);

  const filteredConnections = useMemo(() => {
    const normalized = audienceQuery.trim().toLowerCase();
    if (!normalized) return [];
    return connectionOptions.filter((p) => {
      const label = `${p.displayName || ''} ${p.username || ''}`.toLowerCase();
      return label.includes(normalized);
    });
  }, [audienceQuery, connectionOptions]);

  const dreamsByDate = useMemo(() => {
    const groups = {};
    dreams.forEach((dream) => {
      if (!dream?.createdAt) return;
      const key = formatDreamDate(dream.createdAt, 'yyyy-MM-dd');
      if (!groups[key]) groups[key] = [];
      groups[key].push(dream);
    });
    Object.keys(groups).forEach((key) => {
      groups[key].sort((a, b) => (b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0));
    });
    return groups;
  }, [dreams]);

  const calendarCells = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const firstWeekday = firstDay.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];

    for (let i = 0; i < firstWeekday; i += 1) {
      cells.push({ type: 'spacer', key: `spacer-${i}` });
    }

    const todayKey = getTodayDateInputValue();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(year, month, day);
      const dateKey = formatDateKeyFromLocalDate(date);
      const dayDreams = dreamsByDate[dateKey] || [];
      cells.push({
        type: 'day',
        key: dateKey,
        day,
        dateKey,
        dreamCount: dayDreams.length,
        hasDreams: dayDreams.length > 0,
        isToday: dateKey === todayKey,
        isSelected: selectedCalendarDateKey === dateKey,
      });
    }

    const trailing = (7 - (cells.length % 7)) % 7;
    for (let i = 0; i < trailing; i += 1) {
      cells.push({ type: 'spacer', key: `trailing-${i}` });
    }

    return cells;
  }, [calendarMonth, dreamsByDate, selectedCalendarDateKey]);

  const selectedCalendarDreams = useMemo(() => {
    if (!selectedCalendarDateKey) return [];
    return dreamsByDate[selectedCalendarDateKey] || [];
  }, [dreamsByDate, selectedCalendarDateKey]);

  useEffect(() => {
    if (!selectedCalendarDateKey) return;
    const monthPrefix = monthPrefixFromDate(calendarMonth);
    if (!selectedCalendarDateKey.startsWith(monthPrefix)) {
      setSelectedCalendarDateKey(null);
    }
  }, [selectedCalendarDateKey, calendarMonth]);

  const toggleExcludedViewer = (id) => {
    if (!id) return;
    void triggerLightHaptic();
    setExcludedViewerIds((prev) => prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]);
  };

  const handleRemoveTaggedPerson = (personId) => {
    setTaggedUsers((prev) => prev.filter((entry) => entry.userId !== personId));
  };

  const handleSelectTagSuggestion = (profile) => {
    if (!profile?.id) return;
    if (taggedUsers.some((entry) => entry.userId === profile.id)) {
      setTaggingStatus('Already tagged.');
      return;
    }
    setTaggedUsers((prev) => [...prev, { userId: profile.id, username: profile.username || '', displayName: profile.displayName || 'Dreamer' }]);
    setTagHandle('');
    setTaggingStatus('Tagged successfully.');
    void triggerLightHaptic();
  };

  const handleAddTaggedPerson = async () => {
    const raw = tagHandle.trim();
    if (!raw || !user?.uid) return;
    const normalizedHandle = normalizeHandle(raw);
    if (!normalizedHandle) return;
    if (taggedUsers.some((entry) => entry.username?.toLowerCase() === normalizedHandle)) {
      setTaggingStatus('Already tagged.');
      setTagHandle('');
      return;
    }
    setTaggingBusy(true);
    setTaggingStatus('');
    try {
      const { data } = await supabase
        .from('profiles')
        .select('id, display_name, username')
        .eq('normalized_username', normalizedHandle)
        .single();
      if (!data) { setTaggingStatus('No user found for that handle.'); return; }
      if (data.id === user.uid) { setTaggingStatus('You are already the author.'); return; }
      if (taggedUsers.some((entry) => entry.userId === data.id)) { setTaggingStatus('Already tagged.'); return; }
      setTaggedUsers((prev) => [...prev, { userId: data.id, username: data.username || normalizedHandle, displayName: data.display_name || 'Dreamer' }]);
      setTagHandle('');
      setTaggingStatus('Tagged successfully.');
      void triggerLightHaptic();
    } catch {
      setTaggingStatus('Could not tag that user.');
    } finally {
      setTaggingBusy(false);
    }
  };

  const resetForm = () => {
    setTitle(''); setContent(''); setDreamDate(getTodayDateInputValue());
    setVisibility('private'); setExcludedViewerIds([]);
    setTaggedUsers([]); setTagHandle(''); setTaggingStatus('');
  };

  const appendDictation = useCallback((text) => {
    setContent((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${text}` : text));
  }, []);

  const closeModal = useCallback(() => {
    if (loading) return;
    void triggerLightHaptic();
    setShowNewDream(false);
    resetForm();
  }, [loading]);
  const handleOverlayClick = (e) => { if (e.target === e.currentTarget) closeModal(); };

  useEscapeKey(closeModal, showNewDream);

  const handleSaveDream = async (event) => {
    event.preventDefault();
    if (!content.trim() || !user?.uid) return;
    const titleFeedback = getModerationFeedback(title, { contentType: 'dream title' });
    if (titleFeedback) {
      setToast(titleFeedback);
      return;
    }
    const contentFeedback = getModerationFeedback(content, { contentType: 'dream text' });
    if (contentFeedback) {
      setToast(contentFeedback);
      return;
    }
    setLoading(true);

    const taggedMeta = taggedUsers.map((entry) => ({
      userId: entry.userId, username: entry.username || '', displayName: entry.displayName || ''
    }));
    const resolvedTitle = title.trim() || 'Untitled dream';
    const selectedDreamDate = parseDateInputValue(dreamDate);

    if (!selectedDreamDate) {
      setToast('Choose a valid dream date.');
      setLoading(false);
      return;
    }

    const optimistic = {
      id: `local-${Date.now()}`,
      userId: user.uid,
      title: resolvedTitle,
      content: content.trim(),
      visibility,
      aiGenerated: false,
      authorUsername: visibility === 'anonymous' ? null : (viewerProfile?.username || null),
      createdAt: selectedDreamDate,
      excludedViewerIds,
      taggedUsers: taggedMeta,
      taggedUserIds: taggedMeta.map((e) => e.userId),
      reactionCounts: {},
      viewerReactions: {},
      tags: [],
    };

    setDreams((prev) => [optimistic, ...prev]);

    try {
      const { data: insertedDream, error } = await supabase.from('dreams').insert({
        user_id:             user.uid,
        title:               resolvedTitle,
        content:             content.trim(),
        visibility,
        ai_generated:        false,
        author_username:     visibility === 'anonymous' ? null : (viewerProfile?.username || null),
        excluded_viewer_ids: excludedViewerIds,
        tagged_users:        taggedMeta,
        tagged_user_ids:     taggedMeta.map((e) => e.userId),
        created_at:          selectedDreamDate.toISOString(),
      }).select('*').single();
      if (error) throw error;
      if (insertedDream) {
        const mappedInsertedDream = mapDream(insertedDream);
        setDreams((prev) => prev.map((dream) => (
          dream.id === optimistic.id ? mappedInsertedDream : dream
        )));
      }
      setShowNewDream(false);
      resetForm();
      void triggerSuccessHaptic();
    } catch {
      setDreams((prev) => prev.filter((d) => d.id !== optimistic.id));
      void triggerErrorHaptic();
      setToast('Could not save your dream. Try again in a moment.');
    } finally {
      setLoading(false);
    }
  };

  const handleCardNavigate = (dreamId) => {
    if (!dreamId || dreamId.startsWith('local-')) return;
    void triggerLightHaptic();
    navigate(buildDreamPath(viewerProfile?.username || null, user?.uid, dreamId), { state: { fromNav: '/journal' } });
  };

  const openNewDream = () => {
    void triggerLightHaptic();
    setShowNewDream(true);
  };

  const handleVisibilitySelect = (nextVisibility) => {
    if (nextVisibility !== visibility) {
      void triggerSelectionHaptic();
    }
    setVisibility(nextVisibility);
  };

  const showListView = () => {
    void triggerSelectionHaptic();
    setViewMode('list');
  };

  const showCalendarView = () => {
    void triggerSelectionHaptic();
    // Search only filters the list, so carrying a query into the calendar
    // would leave it empty with no visible input to clear.
    setSearchQuery('');
    setViewMode('calendar');
  };

  const goToPreviousMonth = () => {
    void triggerSelectionHaptic();
    setMonthDirection('prev');
    setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  };

  const goToNextMonth = () => {
    void triggerSelectionHaptic();
    setMonthDirection('next');
    setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  };

  const renderDreamCard = (dream) => {
    const dateLabel = dream.createdAt ? formatDreamDate(dream.createdAt, 'MMM d') : 'Undated';
    const visLabel = CARD_VISIBILITY_LABELS[dream.visibility] || CARD_VISIBILITY_LABELS.private;
    const tagCount = dream.tags?.length || 0;
    const hasAi = Boolean(dream.aiGenerated && dream.aiInsights);
    return (
      <div
        key={dream.id}
        className={`dream-card${dream.id.startsWith('local-') ? ' dream-card--pending' : ''}`}
        onClick={() => handleCardNavigate(dream.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !dream.id.startsWith('local-')) {
            e.preventDefault(); handleCardNavigate(dream.id);
          }
        }}
      >
        <div className="dream-header">
          <div className="dream-meta">
            <span className="dream-date">{dateLabel}</span>
            <span className={`dream-vis-pill dream-vis--${dream.visibility || 'private'}`}>{visLabel}</span>
            {hasAi && <span className="dream-ai-badge" aria-label="AI analyzed">✦</span>}
          </div>
          <span className="dream-chevron" aria-hidden="true">→</span>
        </div>
        <p className="dream-title">
          {searchQuery.trim()
            ? highlightSnippet(dream.title || (dream.aiGenerated && dream.aiTitle) || 'Untitled dream', searchQuery.trim(), 120)
            : dream.title || (dream.aiGenerated && dream.aiTitle) || 'Untitled dream'}
        </p>
        <p className="dream-content">
          {highlightSnippet(dream.content, searchQuery.trim(), CONTENT_PREVIEW_LIMIT)}
        </p>
        {tagCount > 0 && (
          <div className="dream-footer-meta">
            <span className="dream-tag-count">{tagCount} {tagCount === 1 ? 'tag' : 'tags'}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="page-container stream-page">
      <div className="page-header journal-header">
        <div className="journal-header-top">
          <div>
            <h1>Dream Journal</h1>
            <p className="page-subtitle">Your own personal dream archive.</p>
          </div>
          <button type="button" onClick={openNewDream} className="primary-btn">
            + New Dream
          </button>
        </div>
        <div className="view-toggle" role="tablist" aria-label="Dream journal view mode">
          <button
            type="button"
            className={viewMode === 'list' ? 'view-toggle-btn active' : 'view-toggle-btn'}
            role="tab"
            aria-selected={viewMode === 'list'}
            onClick={showListView}
          >
            List
          </button>
          <button
            type="button"
            className={viewMode === 'calendar' ? 'view-toggle-btn active' : 'view-toggle-btn'}
            role="tab"
            aria-selected={viewMode === 'calendar'}
            onClick={showCalendarView}
          >
            Calendar
          </button>
        </div>
      </div>


      {!initialLoading && dreams.length > 0 && viewMode === 'list' && (
        <div className="journal-search-row">
          <input
            type="search"
            className="journal-search-input"
            placeholder="Search your dreams…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search dreams"
          />
        </div>
      )}

      {initialLoading ? (
        <JournalSkeleton />
      ) : filteredDreams.length ? (
        viewMode === 'list' ? (
          <div className="dreams-list">
            {(() => {
              const items = [];
              let lastYear = null;
              for (const dream of filteredDreams) {
                const year = dream.createdAt ? new Date(dream.createdAt).getFullYear() : null;
                if (year && year !== lastYear) {
                  items.push(
                    <div key={`year-${year}`} className="dreams-year-header">
                      <span>{year}</span>
                    </div>
                  );
                  lastYear = year;
                }
                items.push(renderDreamCard(dream));
              }
              return items;
            })()}
          </div>
        ) : (
          <div className="journal-calendar-shell">
            <div className="journal-calendar" aria-label="Dream journal calendar">
              <div className="calendar-toolbar">
                <button type="button" className="calendar-nav-btn" onClick={goToPreviousMonth} aria-label="Previous month">
                  <FontAwesomeIcon icon={faChevronLeft} />
                </button>
                <h2 key={monthPrefixFromDate(calendarMonth)} data-month-direction={monthDirection}>
                  {monthLabel(calendarMonth)}
                </h2>
                <button type="button" className="calendar-nav-btn" onClick={goToNextMonth} aria-label="Next month">
                  <FontAwesomeIcon icon={faChevronRight} />
                </button>
              </div>
              <div className="calendar-weekdays">
                {CALENDAR_WEEKDAYS.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
              <div
                className="calendar-grid"
                key={monthPrefixFromDate(calendarMonth)}
                data-month-direction={monthDirection}
              >
                {calendarCells.map((cell) => {
                  if (cell.type === 'spacer') {
                    return <div key={cell.key} className="calendar-spacer" aria-hidden="true" />;
                  }
                  return (
                    <button
                      key={cell.key}
                      type="button"
                      className={`calendar-day${cell.hasDreams ? ' has-dreams' : ''}${cell.isToday ? ' is-today' : ''}${cell.isSelected ? ' is-selected' : ''}`}
                      onClick={() => setSelectedCalendarDateKey(cell.dateKey)}
                      aria-pressed={cell.isSelected}
                      aria-label={`${dateLabel(cell.dateKey)}${cell.hasDreams ? `, ${cell.dreamCount} dream${cell.dreamCount === 1 ? '' : 's'}` : ', no dreams'}`}
                    >
                      <span className="calendar-day-number">{cell.day}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="calendar-day-panel">
              <div className="calendar-day-panel-body" key={selectedCalendarDateKey || 'none'}>
                {selectedCalendarDateKey ? (
                  <>
                    <div className="calendar-day-panel-head">
                      <h3>{dateLabel(selectedCalendarDateKey)}</h3>
                      <p>{selectedCalendarDreams.length} dream{selectedCalendarDreams.length === 1 ? '' : 's'}</p>
                    </div>
                    {selectedCalendarDreams.length ? (
                      <div className="dreams-list calendar-dreams-list">
                        {selectedCalendarDreams.map((dream) => renderDreamCard(dream))}
                      </div>
                    ) : (
                      <p className="empty-state">No dreams logged for this date.</p>
                    )}
                  </>
                ) : (
                  <p className="empty-state">Select a date to see dreams from that day.</p>
                )}
              </div>
            </div>
          </div>
        )
      ) : dreams.length && searchQuery.trim() ? (
        <p className="empty-state">No dreams match your search.</p>
      ) : (
        <p className="empty-state">No dreams yet. Log your dreams here!</p>
      )}

      {showNewDream && (
        <div className="modal-overlay" onClick={handleOverlayClick}>
          <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="new-dream-heading">
            <div className="modal-header">
              <h2 id="new-dream-heading">New Dream</h2>
              <button type="button" className="close-btn" onClick={closeModal} aria-label="Close modal">×</button>
            </div>
            <div className={`modal-form-wrap${scrollEdge.top ? ' at-top' : ''}${scrollEdge.bottom ? ' at-bottom' : ''}`}>
            <form ref={formScrollRef} onScroll={checkScrollEdge} onSubmit={handleSaveDream}>
              <input
                type="text"
                className="dream-title-input"
                placeholder="Title (optional)"
                aria-label="Dream title (optional)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={loading}
              />
              <div className="dream-date-section">
                <label htmlFor="dream-date-input">When did this dream happen?</label>
                <input
                  id="dream-date-input"
                  type="date"
                  className="dream-date-input"
                  value={dreamDate}
                  onChange={(e) => setDreamDate(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div className="voice-field">
                <textarea
                  className="dream-textarea"
                  placeholder="Describe everything you remember…"
                  aria-label="Dream description"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  disabled={loading}
                />
                <div className="voice-field-affordance">
                  <VoiceInput
                    onTranscript={appendDictation}
                    onNotice={setToast}
                    disabled={loading}
                    label="Dictate your dream"
                  />
                </div>
              </div>
              <div className="visibility-section">
                <p className="section-label">Who can see this dream?</p>
                <div className="visibility-options">
                  {VISIBILITY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={visibility === option.value ? 'visibility-chip active' : 'visibility-chip'}
                      data-vis={option.value}
                      onClick={() => handleVisibilitySelect(option.value)}
                      aria-pressed={visibility === option.value}
                      disabled={loading}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="visibility-helper">
                  {VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.helper}
                </p>
              </div>
              <div className="audience-section">
                <div className="control-headline">
                  <p className="section-label">Hide from specific people</p>
                  <p className="section-helper">Anyone you pick here will never see this entry, regardless of visibility.</p>
                </div>
                {audienceLoading ? (
                  <div className="loading-inline">
                    <LoadingIndicator label="Loading your connections…" size="sm" align="start" />
                  </div>
                ) : connectionOptions.length === 0 ? (
                  <p className="hint">Connect with people to curate who sees limited posts.</p>
                ) : (
                  <>
                    <div className="audience-search-input">
                      <input
                        type="text"
                        placeholder="Search your following"
                        aria-label="Search your following"
                        value={audienceQuery}
                        onChange={(e) => setAudienceQuery(e.target.value)}
                        disabled={loading}
                      />
                    </div>
                    {hasAudienceQuery && (
                      <div className="audience-result-list">
                        {filteredConnections.length ? (
                          filteredConnections.map((profile) => {
                            const isHidden = excludedViewerIds.includes(profile.id);
                            return (
                              <button
                                key={profile.id}
                                type="button"
                                className={`audience-result${isHidden ? ' active' : ''}`}
                                onClick={() => toggleExcludedViewer(profile.id)}
                                disabled={loading}
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
                          <p className="hint">No matches for &ldquo;{audienceQuery}&rdquo;.</p>
                        )}
                      </div>
                    )}
                    {excludedViewerIds.length ? (
                      <div className="selected-pill-row">
                        {excludedViewerIds.map((id) => {
                          const profile = connectionLookup[id];
                          const label = profile?.username ? `@${profile.username}` : profile?.displayName || 'Dreamer';
                          return (
                            <span key={id} className="selected-pill">
                              {label}
                              <button type="button" onClick={() => toggleExcludedViewer(id)} aria-label={`Remove ${label}`} disabled={loading}>×</button>
                            </span>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="hint">No one is hidden right now.</p>
                    )}
                  </>
                )}
              </div>
              <div className="tag-people-section">
                <div className="control-headline">
                  <p className="section-label">Tag people</p>
                  <p className="section-helper">Let specific friends know this dream involves them.</p>
                </div>
                <div className="tag-people-input">
                  <input
                    type="text"
                    placeholder="@username"
                    aria-label="Tag a dreamer by username"
                    value={tagHandle}
                    onChange={(e) => { setTagHandle(e.target.value); setTaggingStatus(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddTaggedPerson(); } }}
                    disabled={loading || taggingBusy}
                  />
                  <button type="button" className="add-tag-btn" onClick={handleAddTaggedPerson} disabled={loading || taggingBusy || !tagHandle.trim()}>
                    {taggingBusy ? 'Tagging…' : 'Tag'}
                  </button>
                </div>
                {tagSuggestions.length > 0 && (
                  <div className="tag-suggestion-list">
                    {tagSuggestions.map((profile) => (
                      <button type="button" key={profile.id} className="tag-suggestion-item" onClick={() => handleSelectTagSuggestion(profile)} disabled={loading}>
                        <span className="suggestion-name">{profile.displayName}</span>
                        {profile.username && <span className="suggestion-username">@{profile.username}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {taggingStatus && <p className="hint status-hint" role="status">{taggingStatus}</p>}
                {taggedUsers.length ? (
                  <div className="tagged-pill-row">
                    {taggedUsers.map((entry) => (
                      <span key={entry.userId} className="tagged-pill">
                        @{entry.username || entry.displayName}
                        <button type="button" aria-label={`Remove ${entry.username || entry.displayName}`} onClick={() => handleRemoveTaggedPerson(entry.userId)} disabled={loading}>×</button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="hint">
                    {visibility === 'private'
                      ? 'Tags are for your own record on this private dream.'
                      : 'Tagged dreamers will see this on their profile.'}
                  </p>
                )}
              </div>
              <p className="ai-hint">Want an AI title or analysis? Save first, then open the dream to generate it.</p>
              <div className="modal-actions">
                <button type="button" className="ghost-btn" onClick={closeModal} disabled={loading}>Cancel</button>
                <button type="submit" className="primary-btn" disabled={loading || !content.trim()}>
                  {loading ? 'Saving…' : 'Save dream'}
                </button>
              </div>
            </form>
            </div>
          </div>
        </div>
      )}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} duration={5000} />}
    </div>
  );
}

DreamJournal.propTypes = { user: appUserPropType };
