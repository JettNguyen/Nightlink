import PropTypes from 'prop-types';
import './SkeletonLoader.css';

// Use these to compose page-specific skeletons.

function S({ w, h, r, className = '' }) {
  return (
    <div
      className={`skel ${className}`}
      style={{
        width: w || '100%',
        height: h || '1rem',
        borderRadius: r || 6,
      }}
    />
  );
}

S.propTypes = {
  w: PropTypes.string,
  h: PropTypes.string,
  r: PropTypes.number,
  className: PropTypes.string,
};

function Circle({ size }) {
  return (
    <div
      className="skel"
      style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0 }}
    />
  );
}

Circle.propTypes = {
  size: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
};

// Matches the `dreams-list` auto-fill grid (minmax(280px, 1fr))
// Shows 6 cards so all columns are populated at any breakpoint.

export function JournalSkeleton() {
  return (
    <div className="sk-journal-grid">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="sk-journal-card">
          <div className="sk-journal-top">
            <S w="68px" h="20px" r={999} />
            <S w="36px" h="18px" r={999} />
          </div>
          <S w="80%" h="1rem" />
          <S h="0.82rem" />
          <S w="65%" h="0.82rem" />
          <div className="sk-journal-footer">
            <S w="44px" h="18px" r={999} />
            <S w="32px" h="18px" r={999} />
          </div>
        </div>
      ))}
    </div>
  );
}

// Matches feed-post: avatar column + byline + title + content + reactions

function FeedCardSkeleton() {
  return (
    <div className="sk-feed-card">
      {/* 40px circle in the avatar column, matching .feed-avatar */}
      <div className="skel sk-feed-avatar" />
      <div className="sk-feed-main">
        <div className="sk-feed-head">
          <S w="110px" h="0.9rem" />
          <S w="90px" h="0.78rem" />
        </div>
        <S w="65%" h="1.05rem" r={6} className="sk-mt-sm" />
        <S h="0.85rem" className="sk-mt-sm" />
        <S w="90%" h="0.85rem" className="sk-mt-sm" />
        <S w="60%" h="0.85rem" className="sk-mt-sm" />
        <div className="sk-feed-footer">
          <S w="44px" h="20px" r={6} />
          <S w="44px" h="20px" r={6} />
          <S w="44px" h="20px" r={6} />
        </div>
      </div>
    </div>
  );
}

export function FeedSkeleton({ count = 3 }) {
  return (
    <div className="sk-feed-list">
      {Array.from({ length: count }).map((_, i) => (
        <FeedCardSkeleton key={i} />
      ))}
    </div>
  );
}

FeedSkeleton.propTypes = {
  count: PropTypes.number,
};

// Header, two counts, the owner actions, then the dreams head and its stream.

export function ProfilePageSkeleton() {
  return (
    <div className="sk-profile">
      <div className="sk-profile-header">
        <div className="sk-profile-identity">
          <Circle size={88} />
          <div className="sk-profile-name">
            <S w="165px" h="1.55rem" r={8} />
            <S w="110px" h="1rem" className="sk-mt-sm" />
          </div>
        </div>
        <S w="240px" h="0.85rem" className="sk-mt" />
        <S w="180px" h="0.85rem" className="sk-mt-sm" />
      </div>
      <div className="sk-profile-stats">
        {[0, 1].map((i) => (
          <div key={i} className="sk-stat-item">
            <S w="26px" h="1rem" r={6} />
            <S w="62px" h="0.8rem" r={4} />
          </div>
        ))}
      </div>
      <S w="140px" h="38px" r={10} className="sk-profile-btn" />
      <div className="sk-profile-head">
        <div className="sk-profile-head-top">
          <S w="84px" h="1.05rem" r={6} />
          <S w="150px" h="0.8rem" r={4} className="sk-mt-sm" />
        </div>
        <div className="sk-profile-head-tabs">
          <S w="82px" h="0.95rem" r={4} />
          <S w="52px" h="0.95rem" r={4} />
        </div>
      </div>
      <div className="sk-profile-grid">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="sk-profile-card">
            <S w="60px" h="18px" r={999} />
            <S w="85%" h="0.95rem" className="sk-mt" />
            <S h="0.8rem" className="sk-mt-sm" />
            <S w="65%" h="0.8rem" className="sk-mt-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProfileDreamsLoadingSkeleton() {
  return (
    <div className="sk-profile-grid">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="sk-profile-card">
          <S w="60px" h="18px" r={999} />
          <S w="85%" h="0.95rem" className="sk-mt" />
          <S h="0.8rem" className="sk-mt-sm" />
          <S w="65%" h="0.8rem" className="sk-mt-sm" />
        </div>
      ))}
    </div>
  );
}

// Back btn + title + date/author + content block + AI section
// Wrapped in sk-detail-card to mirror the actual .detail-card container.

export function DreamDetailSkeleton() {
  return (
    <div className="sk-detail-card">
      <div className="sk-detail-toolbar">
        <S w="88px" h="34px" r={10} />
      </div>
      <div className="sk-detail-title-row">
        <S w="72%" h="1.75rem" r={8} />
        <S w="100px" h="0.85rem" className="sk-mt-sm" />
      </div>
      <div className="sk-detail-author">
        <Circle size={36} />
        <div className="sk-feed-meta">
          <S w="110px" h="0.85rem" />
          <S w="72px" h="0.75rem" />
        </div>
      </div>
      <div className="sk-detail-content">
        {[100, 96, 88, 100, 78, 94, 82, 100, 66, 90, 74, 55].map((w, i) => (
          <S key={i} w={`${w}%`} h="0.9rem" className="sk-mt-sm" />
        ))}
      </div>
      <div className="sk-detail-ai">
        <S w="140px" h="1rem" r={6} />
        {[100, 91, 100, 83, 71, 60].map((w, i) => (
          <S key={i} w={`${w}%`} h="0.85rem" className={i === 0 ? 'sk-mt' : 'sk-mt-sm'} />
        ))}
      </div>
    </div>
  );
}

// Header + section cards

export function InsightsSkeleton() {
  return (
    <div className="sk-insights">
      <div className="sk-insights-header">
        <S w="200px" h="1.75rem" r={8} />
        <S w="140px" h="0.8rem" className="sk-mt-sm" />
      </div>
      {[4, 3, 3].map((rows, ci) => (
        <div key={ci} className="sk-insights-card">
          <div className="sk-insights-card-head">
            <S w="16px" h="16px" r={999} />
            <S w="160px" h="0.95rem" r={6} />
            <S w="60px" h="22px" r={999} className="sk-insights-count" />
          </div>
          {Array.from({ length: rows }).map((_, i) => (
            <S key={i} w={i % 3 === 2 ? '75%' : '100%'} h="0.85rem" className="sk-mt-sm" />
          ))}
        </div>
      ))}
    </div>
  );
}

// Section cards with toggle rows

function ToggleRowSkeleton() {
  return (
    <div className="sk-toggle-row">
      <div className="sk-toggle-label">
        <S w="120px" h="0.9rem" />
        <S w="200px" h="0.78rem" className="sk-mt-sm" />
      </div>
      <S w="48px" h="28px" r={999} className="sk-toggle-switch" />
    </div>
  );
}

export function SettingsSkeleton() {
  return (
    <div className="sk-settings">
      {[
        { head: true, rows: 2 },
        { head: true, rows: 3 },
        { head: true, rows: 1 },
        { head: true, rows: 2 },
      ].map((section, si) => (
        <div key={si} className="sk-settings-section">
          <div className="sk-settings-head">
            <S w="140px" h="1.1rem" r={6} />
            <S w="220px" h="0.8rem" className="sk-mt-sm" />
          </div>
          <div className="sk-settings-body">
            {Array.from({ length: section.rows }).map((_, i) => (
              <ToggleRowSkeleton key={i} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Notification cards: avatar + content lines + clear btn

function ActivityCardSkeleton() {
  return (
    <div className="sk-activity-card">
      <Circle size={42} />
      <div className="sk-activity-body">
        <S w="88%" h="0.85rem" />
        <S w="52%" h="0.8rem" className="sk-mt-sm" />
      </div>
      <S w="28px" h="28px" r={6} className="sk-activity-action" />
    </div>
  );
}

export function ActivitySkeleton() {
  return (
    <div className="sk-activity-list">
      <S w="70px" h="0.8rem" r={4} className="sk-activity-group" />
      {Array.from({ length: 5 }).map((_, i) => (
        <ActivityCardSkeleton key={i} />
      ))}
    </div>
  );
}

// People grid (auto-fit minmax 220px) and dreams grid (auto-fit minmax 260px)

export function SearchPeopleSkeleton() {
  return (
    <div className="sk-people-grid">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="sk-person-card">
          <Circle size={44} />
          <div className="sk-feed-meta">
            <S w="100px" h="0.9rem" />
            <S w="70px" h="0.78rem" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SearchDreamsSkeleton() {
  return (
    <div className="sk-dream-grid">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="sk-search-dream-card">
          <S w="70px" h="18px" r={999} />
          <S w="80%" h="0.95rem" className="sk-mt" />
          <S h="0.8rem" className="sk-mt-sm" />
          <S w="60%" h="0.8rem" className="sk-mt-sm" />
        </div>
      ))}
    </div>
  );
}

// Keep these so any untouched imports don't break.

export function DreamCardSkeleton() {
  return <FeedCardSkeleton />;
}

export function ProfileSkeleton() {
  return <ProfilePageSkeleton />;
}

export function ListSkeleton({ count = 3 }) {
  return <FeedSkeleton count={count} />;
}

ListSkeleton.propTypes = {
  count: PropTypes.number,
};

export default DreamCardSkeleton;
