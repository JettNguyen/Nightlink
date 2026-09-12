import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { useNavigate } from 'react-router-dom';
import { isToday, isYesterday, differenceInCalendarDays } from 'date-fns';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeart, faXmark, faAt, faComment, faUserPlus, faPencil } from '@fortawesome/free-solid-svg-icons';
import { ActivitySkeleton } from '../components/SkeletonLoader';
import AvatarDisplay from '../components/AvatarDisplay';
import fetchUserSummaries from '../services/UserService';
import { DEFAULT_AVATAR_BACKGROUND, DEFAULT_AVATAR_COLOR } from '../constants/avatarOptions';
import { buildDreamPath, buildProfilePath } from '../utils/urlHelpers';
import { markActivityEntryRead, removeActivityEntry } from '../services/ActivityService';
import { triggerLightHaptic, triggerErrorHaptic } from '../utils/haptics';
import './Activity.css';
import { appUserPropType, activityPreviewPropType } from '../propTypes';

// One glyph and one colour per kind of notification, worn on the corner of the
// actor's avatar. A row used to open with a coloured word instead, which put a
// pill, a timestamp, a sentence and a body line on every entry at roughly the
// same weight: nothing to land on when you glance down the list.
const TYPE_META = {
  mention:         { icon: faAt,       tone: 'mention' },
  tag:             { icon: faAt,       tone: 'mention' },
  reply:           { icon: faComment,  tone: 'comment' },
  comment:         { icon: faComment,  tone: 'comment' },
  commentReaction: { icon: faHeart,    tone: 'reaction' },
  reaction:        { icon: faHeart,    tone: 'reaction' },
  follow:          { icon: faUserPlus, tone: 'follow' },
  dreamUpdate:     { icon: faPencil,   tone: 'update' }
};

// Long form reads as another sentence next to the one it is attached to. The
// group heading carries the rough when, so the row only needs the exact one.
const compactTime = (date) => {
  if (!date) return '';
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 365) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 365)}y`;
};

const groupLabel = (date) => {
  if (!date) return 'Earlier';
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  const days = differenceInCalendarDays(new Date(), date);
  if (days < 7) return 'This week';
  if (days < 30) return 'This month';
  return 'Earlier';
};

export default function Activity({ user, activityPreview }) {
  const viewerId = user?.uid || null;
  const navigate = useNavigate();
  const [clearingEntries, setClearingEntries] = useState(() => new Set());
  const [actorSummaries, setActorSummaries] = useState({});

  const {
    inboxEntries = [],
    inboxLoading = Boolean(viewerId),
    inboxError = ''
  } = activityPreview || {};

  const formatReactionEmoji = (emoji) => {
    if (emoji === '💙') {
      return <FontAwesomeIcon icon={faHeart} style={{ color: 'var(--like)' }} />;
    }
    return emoji;
  };

  const activityEntries = useMemo(() => (
    [...inboxEntries].sort((a, b) => {
      const aTime = a.createdAt?.getTime?.() || 0;
      const bTime = b.createdAt?.getTime?.() || 0;
      return bTime - aTime;
    })
  ), [inboxEntries]);

  // Today, then yesterday, then the older buckets. The list is already sorted
  // newest first, so the groups come out in order.
  const activityGroups = useMemo(() => {
    const groups = [];
    activityEntries.forEach((entry) => {
      const label = groupLabel(entry.createdAt);
      const current = groups[groups.length - 1];
      if (current && current.label === label) {
        current.entries.push(entry);
      } else {
        groups.push({ label, entries: [entry] });
      }
    });
    return groups;
  }, [activityEntries]);

  useEffect(() => {
    const ids = [...new Set(activityEntries.map((entry) => entry.actorId).filter(Boolean))];
    if (!ids.length) return undefined;
    let cancelled = false;
    fetchUserSummaries(ids)
      .then((fetched) => {
        if (cancelled || !fetched) return;
        setActorSummaries((prev) => ({ ...prev, ...fetched }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activityEntries]);

  const handleDreamNavigation = (ownerUsername, ownerId, dreamId) => {
    if (!dreamId) return;
    if (ownerUsername) {
      navigate(buildDreamPath(ownerUsername, ownerId, dreamId));
    } else {
      navigate(`/dream/${dreamId}`);
    }
  };

  const handleNotificationInteraction = useCallback(async (entry, action) => {
    if (!entry) return;
    void triggerLightHaptic();
    if (viewerId && entry.read === false) {
      await markActivityEntryRead(viewerId, entry.id);
    }
    action?.();
  }, [viewerId]);

  const handleNotificationClear = useCallback(async (event, entry) => {
    event.preventDefault();
    event.stopPropagation();
    if (!viewerId || !entry?.id) return;

    setClearingEntries((prev) => {
      const next = new Set(prev);
      next.add(entry.id);
      return next;
    });

    try {
      await removeActivityEntry(viewerId, entry.id);
    } catch (error) {
      console.error('Failed to clear notification', error);
      void triggerErrorHaptic();
      setClearingEntries((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
      return;
    }

    setClearingEntries((prev) => {
      const next = new Set(prev);
      next.delete(entry.id);
      return next;
    });
  }, [viewerId]);

  const renderNotificationCard = (entry) => {
    const entryType = entry.type || 'mention';
    const meta = TYPE_META[entryType] || TYPE_META.mention;
    const relativeTime = compactTime(entry.createdAt);
    const actorName = entry.actorDisplayName || 'Someone';
    const dreamTitle = entry.dreamTitleSnapshot || entry.dreamTitle || 'Untitled dream';
    const isUnread = entry.read === false;
    const actor = entry.actorId ? actorSummaries[entry.actorId] : null;
    const subject = <span className="activity-subject">{dreamTitle}</span>;

    // The actor's name is bold and on its own, so the rest of the line is only
    // what they did. It used to be one sentence with the name buried in it.
    let action = <>mentioned you in {subject}</>;
    let bodyText = (entry.content || '').trim();
    let onPress = () => handleDreamNavigation(entry.dreamOwnerUsername, entry.dreamOwnerId, entry.dreamId);

    if (entryType === 'reply') {
      action = <>replied to your comment in {subject}</>;
    } else if (entryType === 'dreamUpdate') {
      action = <>updated {subject}</>;
    } else if (entryType === 'comment') {
      action = <>commented on {subject}</>;
    } else if (entryType === 'commentReaction') {
      action = <>reacted {formatReactionEmoji(entry.emoji)} to your comment in {subject}</>;
      bodyText = '';
    } else if (entryType === 'tag') {
      action = <>tagged you in {subject}</>;
    } else if (entryType === 'reaction') {
      action = <>reacted {formatReactionEmoji(entry.emoji)} to {subject}</>;
      bodyText = '';
    } else if (entryType === 'follow') {
      action = <>started following you</>;
      bodyText = '';
      onPress = () => {
        if (!entry.actorId) return;
        navigate(buildProfilePath(entry.actorUsername || null, entry.actorId));
      };
    }

    const isDisabled = entryType === 'follow' && !entry.actorId && !entry.actorUsername;
    const cardClassName = `activity-card${isUnread ? ' activity-card-unread' : ''}${isDisabled ? ' activity-card-disabled' : ''}`;
    const handleInteraction = () => handleNotificationInteraction(entry, onPress);

    return (
      <article key={entry.id} className={cardClassName}>
        <button
          type="button"
          className="activity-card-main"
          onClick={handleInteraction}
          disabled={isDisabled}
        >
          <span className="activity-avatar-wrap">
            <AvatarDisplay
              photoURL={actor?.photoURL || null}
              avatarIcon={actor?.avatarIcon}
              avatarBackground={actor?.avatarBackground || DEFAULT_AVATAR_BACKGROUND}
              avatarColor={actor?.avatarColor || DEFAULT_AVATAR_COLOR}
              className="activity-avatar"
            />
            <span className={`activity-badge activity-badge--${meta.tone}`} aria-hidden="true">
              <FontAwesomeIcon icon={meta.icon} />
            </span>
          </span>
          <span className="activity-card-text">
            <span className="activity-title" role="text">
              <span className="activity-actor">{actorName}</span>
              {' '}
              {action}
              {relativeTime && <span className="activity-time"> {relativeTime}</span>}
              {isUnread && <span className="activity-dot" aria-label="Unread notification" />}
            </span>
            {bodyText && <span className="activity-body" role="text">{bodyText}</span>}
          </span>
        </button>
        <div className="activity-card-actions">
          <button
            type="button"
            className="activity-clear-btn"
            aria-label={`Clear notification from ${actorName}`}
            disabled={clearingEntries.has(entry.id)}
            onClick={(event) => handleNotificationClear(event, entry)}
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      </article>
    );
  };

  return (
    <div className="page-container stream-page activity-page">
      <div className="activity-head">
        <div className="activity-head-top">
          <h1>Activity</h1>
          <p className="activity-subtitle">Mentions, replies, and dream updates from the people you follow.</p>
        </div>
      </div>

      <section className="activity-section">
        {inboxLoading ? (
          <ActivitySkeleton />
        ) : inboxError && activityEntries.length === 0 ? (
          <p className="detail-hint">{inboxError}</p>
        ) : activityEntries.length ? (
          <div className="activity-list">
            {activityGroups.map((group) => (
              <Fragment key={group.label}>
                <h2 className="activity-group"><span>{group.label}</span></h2>
                {group.entries.map((entry) => renderNotificationCard(entry))}
              </Fragment>
            ))}
          </div>
        ) : (
          <p className="detail-hint">You don’t have any notifications yet.</p>
        )}
      </section>

    </div>
  );
}

Activity.propTypes = {
  user: appUserPropType,
  activityPreview: activityPreviewPropType
};
