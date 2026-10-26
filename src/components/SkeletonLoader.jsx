import PropTypes from 'prop-types';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPencil, faGear } from '@fortawesome/free-solid-svg-icons';
import './SkeletonLoader.css';

// Each skeleton is built from its page's own layout classes, with shimmer where
// the words go. They used to copy those layouts into classes of their own, and
// the copies drifted: rows inset twice, a gutter of 1.25rem where the page uses
// 16px on a phone, a back button iOS never draws, and line heights that made
// every row shorter than the one that replaced it. Built this way a skeleton
// takes the same box as the real row at every width, on the Duo in each posture
// and on a phone or a desktop alike, and follows the page when its layout moves.
//
// `sk` marks a skeleton's outermost elements: SkeletonLoader.css takes the
// row's press, hover and entrance animation back off everything inside.

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

// One line of text. It sits inside the element the real text would, so it is
// exactly as tall as that element's line, at whatever size the page sets type.
// Inside a flex row give it a width in em, since a percentage of a box that is
// sized by its own content has nothing to resolve against.
function Line({ w = '100%', className = '' }) {
  return (
    <span className={`sk-line ${className}`}>
      <span className="skel sk-line-bar" style={{ width: w }} />
    </span>
  );
}

Line.propTypes = {
  w: PropTypes.string,
  className: PropTypes.string,
};

// A paragraph. Past the phone layout, on the open Duo held sideways or a
// desktop, the same words take about half as many lines as on a phone, or more
// where a grid splits into columns, so `wide` gives the lines for a screen
// wider than 768px. The upright Duo and the folded one are under that and wrap
// like a phone.
function Lines({ widths, wide }) {
  if (!wide) return widths.map((w, i) => <Line key={i} w={w} />);
  return (
    <>
      {widths.map((w, i) => <Line key={`n${i}`} w={w} className="sk-line--narrow" />)}
      {wide.map((w, i) => <Line key={`w${i}`} w={w} className="sk-line--wide" />)}
    </>
  );
}

Lines.propTypes = {
  widths: PropTypes.arrayOf(PropTypes.string).isRequired,
  wide: PropTypes.arrayOf(PropTypes.string),
};

// A pill, a button or a field with a fixed label. The label is laid out but
// not drawn, so the shape is exactly the size of the real control. Pass the real
// control's tag in `as`: a button sets its line at the browser's normal height
// rather than the page's 1.5, and a textarea is sized by its rows.
function Ghost({ as: Tag = 'span', className = '', children }) {
  const controlProps = Tag === 'button' ? { type: 'button', tabIndex: -1 }
    : Tag === 'textarea' ? { tabIndex: -1, readOnly: true }
    : {};
  return <Tag className={`${className} skel sk-ghost`} {...controlProps}>{children}</Tag>;
}

Ghost.propTypes = {
  as: PropTypes.elementType,
  className: PropTypes.string,
  children: PropTypes.node,
};

// The heart, the comment count and the add button under a dream.
function ReactionsSkeleton({ className }) {
  return (
    <div className={`activity-reactions ${className}`}>
      <div className="reaction-buttons">
        <span className="reaction-button"><S w="2.1rem" h="1.05rem" r={999} /></span>
        <span className="reaction-button"><S w="2.1rem" h="1.05rem" r={999} /></span>
        <span className="reaction-button"><S w="1.05rem" h="1.05rem" r={999} /></span>
      </div>
    </div>
  );
}

ReactionsSkeleton.propTypes = {
  className: PropTypes.string.isRequired,
};

// ── Journal ─────────────────────────────────────────────────────────────────
// The search field, the year, then the stream of entries. The field only shows
// once there are dreams, which is the case almost every time this loads.

const JOURNAL_ROWS = [
  { title: '58%', content: ['100%', '96%', '62%'], wide: ['100%', '48%'], tags: true },
  { title: '44%', content: ['100%', '88%', '70%'], wide: ['100%', '62%'], tags: false },
  { title: '66%', content: ['100%', '93%', '40%'], wide: ['86%'], tags: true },
  { title: '50%', content: ['100%', '97%', '76%'], wide: ['100%', '70%'], tags: false },
  { title: '38%', content: ['100%', '90%', '55%'], wide: ['100%', '30%'], tags: false },
];

export function JournalSkeleton() {
  return (
    <>
      <div className="journal-search-row sk" aria-hidden="true">
        <Ghost as="div" className="journal-search-input sk-field">&nbsp;</Ghost>
      </div>
      <div className="dreams-list sk" aria-hidden="true">
        <div className="dreams-year-header"><span><Line w="2.6em" /></span></div>
        {JOURNAL_ROWS.map((row, i) => (
          <div key={i} className="dream-card">
            <div className="dream-header">
              <div className="dream-meta">
                <span className="dream-date"><Line w="3.2em" /></span>
                <Ghost className="dream-vis-pill">Public</Ghost>
              </div>
              <span className="dream-chevron sk-hidden">→</span>
            </div>
            <p className="dream-title"><Line w={row.title} /></p>
            <p className="dream-content"><Lines widths={row.content} wide={row.wide} /></p>
            {row.tags && (
              <div className="dream-footer-meta">
                <span className="dream-tag-count"><Line w="3em" /></span>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ── Feed ────────────────────────────────────────────────────────────────────

const FEED_ROWS = [
  { title: '62%', content: ['100%', '94%', '58%'], wide: ['100%', '40%'] },
  { title: '48%', content: ['100%', '97%', '90%', '36%'], wide: ['100%', '84%'] },
  { title: '70%', content: ['100%', '72%'], wide: ['78%'] },
];

function FeedPostSkeleton({ title, content, wide }) {
  return (
    <div className="feed-post">
      <span className="skel feed-avatar" />
      <div className="feed-post-main">
        <div className="feed-post-head">
          <div className="feed-post-byline">
            <span className="feed-author-handle"><Line w="6.5em" /></span>
            <Ghost className="vis-badge">Public</Ghost>
            <span className="feed-post-meta"><Line w="5.5em" /></span>
          </div>
        </div>
        <h3 className="feed-title"><Line w={title} /></h3>
        <p className="feed-content"><Lines widths={content} wide={wide} /></p>
        <ReactionsSkeleton className="feed-reactions" />
      </div>
    </div>
  );
}

FeedPostSkeleton.propTypes = {
  title: PropTypes.string.isRequired,
  content: PropTypes.arrayOf(PropTypes.string).isRequired,
  wide: PropTypes.arrayOf(PropTypes.string).isRequired,
};

export function FeedSkeleton({ count = 3 }) {
  return (
    <div className="feed-list sk" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <FeedPostSkeleton key={i} {...FEED_ROWS[i % FEED_ROWS.length]} />
      ))}
    </div>
  );
}

FeedSkeleton.propTypes = {
  count: PropTypes.number,
};

// ── Profile ─────────────────────────────────────────────────────────────────
// Rendered straight into the page's `stream-page` container, the way the
// loaded profile is, so each block takes the margin that page gives it. Your
// own profile has Edit Profile and Settings under the counts; anyone else's
// has the follow button below them.

function ProfileDreamRows() {
  return (
    <div className="profile-dream-grid sk" aria-hidden="true">
      {['60%', '46%', '68%', '52%', '40%'].map((title, i) => (
        <div key={i} className="profile-dream-card">
          <div className="profile-dream-top">
            <Ghost className="dream-date-pill">Oct 24</Ghost>
            <Ghost className="profile-vis-pill">Public</Ghost>
          </div>
          <h3 className="profile-dream-title"><Line w={title} /></h3>
          <p className="profile-dream-snippet"><Lines widths={['100%', i % 2 ? '58%' : '82%']} wide={['100%', '96%', i % 2 ? '44%' : '70%']} /></p>
          {i % 2 === 0 && (
            <div className="profile-dream-footer-meta">
              <span className="profile-tag-count"><Line w="4.5em" /></span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ProfilePageSkeleton({ own = true, showSettings = true }) {
  return (
    <>
      <div className="profile-top sk" aria-hidden="true">
        <div className="profile-top-main">
          <div className="profile-header">
            <div className="profile-identity">
              <div className="profile-avatar"><span className="avatar-circle skel sk-ghost" /></div>
              <div className="profile-info">
                <h1><Line w="6.5em" /></h1>
                <p className="profile-username"><Line w="6em" /></p>
              </div>
            </div>
            <p className="profile-bio"><Line w="78%" /></p>
          </div>
          <div className="profile-stats">
            {[0, 1].map((i) => (
              <div key={i} className="stat-item stat-button">
                <div className="stat-value"><Line w="1.2em" /></div>
                <div className="stat-label"><Line w="4.4em" /></div>
              </div>
            ))}
          </div>
        </div>
        {own && (
          <div className="profile-btn-row">
            <Ghost as="button" className="edit-profile-btn"><FontAwesomeIcon icon={faPencil} /><span>Edit Profile</span></Ghost>
            {showSettings && <Ghost as="button" className="settings-btn"><FontAwesomeIcon icon={faGear} /><span>Settings</span></Ghost>}
          </div>
        )}
      </div>
      {!own && (
        <div className="follow-actions sk" aria-hidden="true">
          <div className="follow-actions-row follow-actions-row-primary">
            <Ghost as="button" className="follow-action-btn follow-action-btn-follow">Follow</Ghost>
          </div>
        </div>
      )}
      <div className="profile-dreams sk" aria-hidden="true">
        <div className="profile-dreams-head">
          <div className="profile-dreams-head-top">
            <h2><Line w="3.6em" /></h2>
            <span className="swap-text profile-dreams-subtitle"><Line w="8em" /></span>
          </div>
          <div className="dream-tab-group">
            <span className="dream-tab"><Line w="6.2em" /></span>
            <span className="dream-tab"><Line w="3.6em" /></span>
          </div>
        </div>
        <ProfileDreamRows />
      </div>
    </>
  );
}

ProfilePageSkeleton.propTypes = {
  own: PropTypes.bool,
  showSettings: PropTypes.bool,
};

// The dreams under the profile header, while a tab is still loading.
export function ProfileDreamsLoadingSkeleton() {
  return <ProfileDreamRows />;
}

// ── Dream Detail ────────────────────────────────────────────────────────────
// The back button is web only, as on the page. Someone else's dream has their
// name above it and the reactions and comment box under it. Your own has no
// author row, a date and an Edit button you can use, and opens on its analysis.
// A new dream is private, with no reactions or comments to hold room for.

export function DreamDetailSkeleton({ showBack = true, owner = false }) {
  return (
    <div className="detail-card sk" aria-hidden="true">
      {showBack && (
        <div className="detail-toolbar">
          <Ghost as="button" className="page-back-btn">Back</Ghost>
        </div>
      )}
      <div className="detail-head">
        <div className="detail-title-block">
          <h1 className="detail-title"><Line w="72%" /></h1>
        </div>
        <div className="detail-date-block">
          {owner ? (
            <>
              <Ghost as="button" className="detail-date-pill detail-date-pill--interactive">
                October 24, 2026
                <FontAwesomeIcon icon={faPencil} className="edit-hint" />
              </Ghost>
              <Ghost as="button" className="ghost-btn ghost-btn--compact detail-edit-content-btn">Edit content</Ghost>
            </>
          ) : (
            <Ghost className="detail-date-pill">October 24, 2026</Ghost>
          )}
        </div>
      </div>
      {!owner && (
        <div className="detail-author-block">
          <button type="button" tabIndex={-1} className="detail-author-btn">
            <span className="skel detail-author-avatar" />
            <span className="detail-author-meta">
              <span className="detail-author-name"><Line w="7em" /></span>
              <span className="detail-author-handle"><Line w="5em" /></span>
            </span>
          </button>
        </div>
      )}
      <div className="detail-body">
        <p><Lines widths={['100%', '96%', '100%', '91%', '100%', '64%']} wide={['100%', '97%', '52%']} /></p>
      </div>
      {owner ? (
        <div className="detail-summary">
          <div className="detail-summary-text">
            <h3><Line w="4.5em" /></h3>
            <p className="detail-insight"><Lines widths={['100%', '94%', '100%', '58%']} wide={['100%', '66%']} /></p>
          </div>
        </div>
      ) : (
        <>
          <ReactionsSkeleton className="detail-reactions" />
          <div className="detail-comments">
            <div className="detail-section-head">
              <p className="detail-label"><Line w="7em" /></p>
            </div>
            <div className="comment-composer">
              <Ghost as="textarea" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

DreamDetailSkeleton.propTypes = {
  showBack: PropTypes.bool,
  owner: PropTypes.bool,
};

// ── Insights ────────────────────────────────────────────────────────────────
// Goes inside the page's own `insights-page`, after its back button.

export function InsightsSkeleton() {
  return (
    <>
      <div className="insights-header sk" aria-hidden="true">
        <h1 className="insights-title"><Line w="7em" /></h1>
        <p className="insights-updated"><Line w="10em" /></p>
      </div>
      <div className="insights-sections sk" aria-hidden="true">
        {[3, 2, 2].map((rows, ci) => (
          <div key={ci} className="insights-card">
            <div className="insights-card-header">
              <span className="insights-card-icon sk-hidden">◈</span>
              <h2 className="insights-card-title"><Line w="9em" /></h2>
              <span className="insights-card-count"><Line w="4em" /></span>
            </div>
            <ul className="insights-entries">
              {Array.from({ length: rows }).map((_, i) => (
                <li key={i} className="insights-entry">
                  <span className="insights-entry-text"><Line w={i % 2 ? '64%' : '86%'} /></span>
                  <Ghost className="insights-entry-badge">3×</Ghost>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────
// Goes where the sections will, under the page header. The save bar only
// appears once settings have loaded, so it is held here too. Billing on iOS
// goes through the App Store, with its own labels and a restore button.

function ToggleRowSkeleton() {
  return (
    <div className="toggle-row">
      <div className="toggle-label">
        <strong><Line w="8em" /></strong>
        <span><Line w="90%" /></span>
      </div>
      <S w="48px" h="28px" r={999} />
    </div>
  );
}

export function SettingsSkeleton({ native = false }) {
  return (
    <>
      <div className="save-bar sk" aria-hidden="true">
        <p><Line w="8em" /></p>
        <div className="btn-group">
          <Ghost as="button" className="ghost-btn">Discard</Ghost>
          <Ghost as="button" className="ghost-btn">Save</Ghost>
        </div>
      </div>
      <div className="settings-sections sk" aria-hidden="true">
        <section className="settings-section">
          <div className="settings-section-head">
            <h2><Line w="3.5em" /></h2>
            <p><Lines widths={['100%', '54%']} wide={['82%']} /></p>
          </div>
          <div className="settings-section-body">
            <div className="notification-support">
              <Ghost className="notification-chip">Plan: Free</Ghost>
              <Ghost className="notification-chip">{native ? 'Free this month: 1' : 'Free this month left: 1'}</Ghost>
              <Ghost className="notification-chip">Paid credits: 0</Ghost>
            </div>
            <div className="action-buttons">
              <Ghost as="button" className="ghost-btn">{native ? 'Upgrade to Pro' : 'Subscribe to Pro'}</Ghost>
              <Ghost as="button" className="ghost-btn">Buy 10 AI credits</Ghost>
            </div>
            {native && <Ghost as="button" className="rc-restore-btn">Restore purchases</Ghost>}
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-section-head">
            <h2><Line w="7.5em" /></h2>
            <p><Lines widths={['100%', '100%', '100%', '36%']} wide={['100%', '64%']} /></p>
          </div>
          <div className="settings-section-body">
            <div className="prompt-options">
              {[0, 1, 2, 3].map((i) => (
                <button key={i} type="button" tabIndex={-1} className="prompt-option">
                  <h3><Line w="6em" /></h3>
                  <p><Lines widths={['100%', '70%']} wide={['100%', '100%', '45%']} /></p>
                </button>
              ))}
            </div>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-section-head">
            <h2><Line w="6.5em" /></h2>
            <p><Line w="88%" /></p>
          </div>
          <div className="settings-section-body">
            {!native && (
              <div className="notification-support">
                <Ghost className="notification-chip">Browser supports push</Ghost>
                <Ghost className="notification-chip">Permission pending</Ghost>
              </div>
            )}
            <ToggleRowSkeleton />
            <ToggleRowSkeleton />
            <ToggleRowSkeleton />
          </div>
        </section>
      </div>
    </>
  );
}

SettingsSkeleton.propTypes = {
  native: PropTypes.bool,
};

// ── Activity ────────────────────────────────────────────────────────────────

export function ActivitySkeleton() {
  return (
    <div className="activity-list sk" aria-hidden="true">
      <h2 className="activity-group"><span><Line w="5em" /></span></h2>
      {['88%', '76%', '92%', '70%', '84%'].map((w, i) => (
        <div key={i} className="activity-card">
          <div className="activity-card-main">
            <span className="activity-avatar-wrap"><span className="skel activity-avatar" /></span>
            <span className="activity-card-text">
              <span className="activity-title"><Lines widths={[w, i % 2 ? '30%' : '44%']} wide={[i % 2 ? '58%' : '66%']} /></span>
            </span>
          </div>
          <div className="activity-card-actions">
            <span className="activity-clear-btn" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Search ──────────────────────────────────────────────────────────────────

export function SearchPeopleSkeleton() {
  return (
    <div className="people-grid sk" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="person-card">
          <span className="skel person-avatar" />
          <div>
            <div className="person-name"><Line w="7em" /></div>
            <div className="person-username"><Line w="5em" /></div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function SearchDreamsSkeleton() {
  return (
    <div className="dream-grid sk" aria-hidden="true">
      {['64%', '48%', '72%', '56%'].map((title, i) => (
        <div key={i} className="search-dream-card">
          <div className="search-dream-meta">
            <Ghost className="vis-badge">Public</Ghost>
            <span className="search-dream-date"><Line w="5.5em" /></span>
          </div>
          <h3><Line w={title} /></h3>
          <p className="dream-snippet"><Lines widths={['100%', '94%', '100%', '50%']} wide={['100%', '72%']} /></p>
        </div>
      ))}
    </div>
  );
}
