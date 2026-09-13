import { useLayoutEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeart } from '@fortawesome/free-solid-svg-icons';
import { DEFAULT_AVATAR_BACKGROUND, DEFAULT_AVATAR_COLOR } from '../constants/avatarOptions';
import AvatarDisplay from './AvatarDisplay';
import './ReactionInsightsModal.css';

const VIEWPORT_MARGIN = 16;
const GAP = 10;
const BLUE_HEART = '💙';

const renderEmojiBadge = (symbol) => {
  if (!symbol) return null;
  if (symbol === BLUE_HEART) {
    return (
      <FontAwesomeIcon
        icon={faHeart}
        className="reaction-popover-emoji reaction-popover-emoji-heart"
        aria-hidden="true"
      />
    );
  }
  return (
    <span className="reaction-popover-emoji" aria-hidden="true">{symbol}</span>
  );
};

export default function ReactionInsightsModal({
  open = false,
  anchorRect = null,
  title = 'Reactions',
  subtitle = '',
  emoji = '',
  entries = []
}) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const cardRef = useRef(null);
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    if (!open || !anchorRect) {
      setPosition(null);
      return undefined;
    }

    const card = cardRef.current;
    if (!card) return undefined;

    const measureAndPosition = () => {
      const popRect = card.getBoundingClientRect();
      const width = popRect.width || card.offsetWidth || 0;
      const height = popRect.height || card.offsetHeight || 0;

      const viewportWidth = typeof window !== 'undefined'
        ? window.innerWidth
        : (typeof document !== 'undefined' ? document.documentElement.clientWidth : 0);
      const viewportHeight = typeof window !== 'undefined'
        ? window.innerHeight
        : (typeof document !== 'undefined' ? document.documentElement.clientHeight : 0);

      if (!viewportWidth || !viewportHeight) {
        setPosition(null);
        return;
      }

      const anchorCenterX = anchorRect.left + (anchorRect.width / 2);
      const availableAbove = anchorRect.top - VIEWPORT_MARGIN - GAP;
      const availableBelow = viewportHeight - anchorRect.bottom - VIEWPORT_MARGIN - GAP;

      let placement = 'top';
      if ((availableBelow > availableAbove && availableBelow >= height) || availableAbove < height) {
        placement = 'bottom';
      }

      const top = placement === 'top'
        ? Math.max(VIEWPORT_MARGIN, anchorRect.top - GAP - height)
        : Math.min(viewportHeight - VIEWPORT_MARGIN - height, anchorRect.bottom + GAP);

      let left = anchorCenterX - (width / 2);
      left = Math.min(
        viewportWidth - VIEWPORT_MARGIN - width,
        Math.max(VIEWPORT_MARGIN, left)
      );

      const pointerOffset = Math.min(
        width - 18,
        Math.max(18, anchorCenterX - left)
      );

      setPosition({ top, left, placement, pointerOffset });
    };

    const supportsRaf = typeof window !== 'undefined'
      && typeof window.requestAnimationFrame === 'function'
      && typeof window.cancelAnimationFrame === 'function';

    let frame = supportsRaf ? window.requestAnimationFrame(measureAndPosition) : null;
    if (!supportsRaf) {
      measureAndPosition();
    }

    const scheduleUpdate = () => {
      if (supportsRaf) {
        if (frame) window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(measureAndPosition);
      } else {
        measureAndPosition();
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', scheduleUpdate);
      window.addEventListener('scroll', scheduleUpdate, true);
    }

    let resizeObserver;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleUpdate);
      resizeObserver.observe(card);
    }

    return () => {
      if (frame && supportsRaf) window.cancelAnimationFrame(frame);
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', scheduleUpdate);
        window.removeEventListener('scroll', scheduleUpdate, true);
      }
      resizeObserver?.disconnect();
    };
  }, [open, anchorRect, safeEntries.length, title, subtitle, emoji]);

  if (!open || !anchorRect) return null;

  const viewportHeight = typeof window !== 'undefined'
    ? window.innerHeight
    : (typeof document !== 'undefined' ? document.documentElement.clientHeight : 0);
  const fallbackPlacement = anchorRect.top > (viewportHeight / 2 || 0) ? 'top' : 'bottom';
  const fallbackTop = fallbackPlacement === 'top'
    ? anchorRect.top - GAP
    : anchorRect.bottom + GAP;
  const fallbackLeft = anchorRect.left + (anchorRect.width / 2);
  const placement = position?.placement || fallbackPlacement;
  const popoverStyle = {
    top: position?.top ?? fallbackTop,
    left: position?.left ?? fallbackLeft,
    '--pointer-offset': position ? `${position.pointerOffset}px` : '50%'
  };

  return (
    <div
      className={`reaction-popover placement-${placement}`}
      style={popoverStyle}
      role="dialog"
      aria-label={title}
      aria-live="polite"
    >
      <div ref={cardRef} className="reaction-popover-card">
        <div className="reaction-popover-head">
          <p className="reaction-popover-title">{title}</p>
          {subtitle && (
            <p className="reaction-popover-subtitle">
              {renderEmojiBadge(emoji)}
              {subtitle}
            </p>
          )}
        </div>
        {safeEntries.length === 0 ? (
          <p className="reaction-popover-empty">No participants yet.</p>
        ) : (
          <ul className="reaction-popover-list">
            {safeEntries.map((entry) => {
              return (
                <li key={entry.id} className="reaction-popover-row">
                  <AvatarDisplay
                    photoURL={entry.photoURL || null}
                    avatarIcon={entry.avatarIcon}
                    avatarBackground={entry.avatarBackground || DEFAULT_AVATAR_BACKGROUND}
                    avatarColor={entry.avatarColor || DEFAULT_AVATAR_COLOR}
                    fallbackText={entry.displayName?.[0] || '?'}
                    className="reaction-popover-avatar"
                  />
                  <div className="reaction-popover-meta">
                    <span className="reaction-popover-name">{entry.displayName || 'Dreamer'}</span>
                    {entry.username && (
                      <span className="reaction-popover-username">@{entry.username}</span>
                    )}
                  </div>
                  {entry.emoji && (
                    <span className="reaction-popover-row-emoji" aria-hidden="true">{entry.emoji}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

ReactionInsightsModal.propTypes = {
  open: PropTypes.bool,
  anchorRect: PropTypes.shape({
    top: PropTypes.number.isRequired,
    bottom: PropTypes.number.isRequired,
    left: PropTypes.number.isRequired,
    right: PropTypes.number.isRequired,
    width: PropTypes.number.isRequired,
    height: PropTypes.number.isRequired
  }),
  title: PropTypes.string,
  subtitle: PropTypes.string,
  emoji: PropTypes.string,
  entries: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string.isRequired,
    emoji: PropTypes.string,
    displayName: PropTypes.string,
    username: PropTypes.string,
    avatarIcon: PropTypes.string,
    avatarBackground: PropTypes.string,
    avatarColor: PropTypes.string
  }))
};
