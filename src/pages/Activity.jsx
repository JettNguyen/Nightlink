import { useCallback, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeart } from '@fortawesome/free-solid-svg-icons';
import { ActivitySkeleton } from '../components/SkeletonLoader';
import { buildDreamPath, buildProfilePath } from '../utils/urlHelpers';
import { markActivityEntryRead, removeActivityEntry } from '../services/ActivityService';
import { triggerLightHaptic, triggerErrorHaptic } from '../utils/haptics';
import './Activity.css';
import { appUserPropType, activityPreviewPropType } from '../propTypes';

export default function Activity({ user, activityPreview }) {
  const viewerId = user?.uid || null;
  const navigate = useNavigate();
  const [clearingEntries, setClearingEntries] = useState(() => new Set());

  const {
    inboxEntries = [],
    inboxLoading = Boolean(viewerId),
    inboxError = ''
  } = activityPreview || {};

  const formatReactionEmoji = (emoji) => {
    if (emoji === '💙') {
      return <FontAwesomeIcon icon={faHeart} style={{ color: 'var(--primary)' }} />;
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

  const notificationsSummary = useMemo(() => {
    if (!activityEntries.length) return 'You’re all caught up';
    if (activityEntries.length === 1) return '1 update';
    return `Latest ${activityEntries.length} updates`;
  }, [activityEntries.length]);

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
    const relativeTime = entry.createdAt ? formatDistanceToNow(entry.createdAt, { addSuffix: true }) : 'moments ago';
    const actorName = entry.actorDisplayName || 'Someone';
    const dreamTitle = entry.dreamTitleSnapshot || entry.dreamTitle || 'Untitled dream';
    const bodyFallback = (entry.content || '').trim() || 'Tap to view the dream.';
    const isUnread = entry.read === false;

    let pillLabel = 'Mention';
    let headline = `${actorName} mentioned you in “${dreamTitle}”`;
    let bodyText = bodyFallback;
    let onPress = () => handleDreamNavigation(entry.dreamOwnerUsername, entry.dreamOwnerId, entry.dreamId);

    if (entryType === 'reply') {
      pillLabel = 'Reply';
      headline = `${actorName} replied to your comment in “${dreamTitle}”`;
    } else if (entryType === 'dreamUpdate') {
      pillLabel = 'Update';
      headline = `${actorName} updated “${dreamTitle}”`;
    } else if (entryType === 'comment') {
      pillLabel = 'Comment';
      headline = `${actorName} commented on “${dreamTitle}”`;
    } else if (entryType === 'commentReaction') {
      pillLabel = 'Reaction';
      headline = `${actorName} reacted to your comment in “${dreamTitle}”`;
      bodyText = entry.emoji ? <span>Reaction: {formatReactionEmoji(entry.emoji)}</span> : bodyFallback;
    } else if (entryType === 'tag') {
      pillLabel = 'Tag';
      headline = `${actorName} tagged you in "${dreamTitle}"`;
    } else if (entryType === 'reaction') {
      pillLabel = 'Reaction';
      headline = `${actorName} reacted to "${dreamTitle}"`;
      bodyText = entry.emoji ? <span>Reaction: {formatReactionEmoji(entry.emoji)}</span> : bodyFallback;
    } else if (entryType === 'follow') {
      pillLabel = 'Follow';
      headline = `${actorName} followed you`;
      bodyText = entry.actorUsername ? `@${entry.actorUsername}` : 'Tap to view their profile.';
      onPress = () => {
        if (!entry.actorId) return;
        navigate(buildProfilePath(entry.actorUsername || null, entry.actorId));
      };
    }

    const isDisabled = entryType === 'follow' && !entry.actorId && !entry.actorUsername;
    const cardClassName = `activity-card${isUnread ? ' activity-card-unread' : ''}${isDisabled ? ' activity-card-disabled' : ''}`;

    const handleInteraction = () => handleNotificationInteraction(entry, onPress);

    return (
      <article
        key={entry.id}
        className={cardClassName}
      >
          <button
            type="button"
            className="activity-card-main"
            onClick={handleInteraction}
            disabled={isDisabled}
          >
            <span className="activity-card-head">
              <span className="activity-pill-group">
                <span className={`activity-pill ${entryType}`}>{pillLabel}</span>
                {isUnread && <span className="activity-dot" aria-label="Unread notification" />}
              </span>
              <span className="activity-time">{relativeTime}</span>
            </span>
            <span className="activity-title" role="text">{headline}</span>
            <span className="activity-body" role="text">{bodyText}</span>
          </button>
          <div className="activity-card-actions">
            <button
              type="button"
              className="activity-clear-btn"
              aria-label={`Clear notification: ${headline}`}
              disabled={clearingEntries.has(entry.id)}
              onClick={(event) => handleNotificationClear(event, entry)}
            >
              Clear
            </button>
          </div>
      </article>
    );
  };

  return (
    <div className="page-container stream-page activity-page">
      <div className="activity-head">
        <div>
          <h1>Activity</h1>
          <p className="activity-subtitle">Mentions, replies, and dream updates from the people you follow.</p>
        </div>
      </div>

      <section className="activity-section">
        <div className="activity-section-head">
          <div>
            <h2>Notifications</h2>
            <p className="activity-subtitle">{notificationsSummary}</p>
          </div>
        </div>
        {inboxLoading ? (
          <ActivitySkeleton />
        ) : inboxError && activityEntries.length === 0 ? (
          <p className="detail-hint">{inboxError}</p>
        ) : activityEntries.length ? (
          <div className="activity-list">
            {activityEntries.map((entry) => renderNotificationCard(entry))}
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
