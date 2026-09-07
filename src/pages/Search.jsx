import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabase';
import { mapDream } from '../utils/mappers';
import { DEFAULT_AVATAR_BACKGROUND, DEFAULT_AVATAR_COLOR } from '../constants/avatarOptions';
import AvatarDisplay from '../components/AvatarDisplay';
import ProBadge from '../components/ProBadge';
import { SearchPeopleSkeleton, SearchDreamsSkeleton } from '../components/SkeletonLoader';
import Toast from '../components/Toast';
import { formatDreamDate } from '../utils/dates';
import { buildProfilePath, buildDreamPath } from '../utils/urlHelpers';
import { highlightSnippet } from '../utils/highlight';
import { triggerSelectionHaptic, triggerLightHaptic } from '../utils/haptics';
import './Search.css';
import { appUserPropType } from '../propTypes';

const MIN_CHARS = 2;

export default function Search({ user }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [userResults, setUserResults] = useState([]);
  const [dreamResults, setDreamResults] = useState([]);
  const [toast, setToast] = useState(null);
  const [lastTerm, setLastTerm] = useState('');
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState('people');
  const navigate = useNavigate();
  const currentUserId = user?.uid || null;
  const filters = [{ id: 'people', label: 'People' }, { id: 'dreams', label: 'Dreams' }];

  // `pending` covers the debounce window so results already on screen are not
  // briefly reported as "no matches" for a term that has not been run yet.
  useEffect(() => {
    if (searchTerm.trim().length >= MIN_CHARS) setPending(true);
    const handler = setTimeout(() => { runSearch(); }, 280);
    return () => clearTimeout(handler);
  }, [searchTerm, filter]);

  const runSearch = async () => {
    const term = searchTerm.trim();
    if (term.length < MIN_CHARS) {
      setUserResults([]); setDreamResults([]); setLastTerm(''); setLoading(false); setPending(false);
      return;
    }
    setLoading(true); setLastTerm(term);
    const wordBound = searchTerm.endsWith(' ');
    try {
      const lower = `%${term.toLowerCase()}%`;
      if (filter === 'people') {
        const { data } = await supabase
          .from('profiles')
          .select('id, display_name, username, photo_url, avatar_icon, avatar_background, avatar_color, subscription')
          .or(`display_name.ilike.${lower},username.ilike.${lower}`)
          .neq('id', currentUserId || '00000000-0000-0000-0000-000000000000')
          .limit(15);
        setUserResults((data || []).map((r) => ({
          id: r.id,
          displayName: r.display_name || 'Dreamer',
          username: r.username || '',
          photoURL: r.photo_url || null,
          avatarIcon: r.avatar_icon,
          avatarBackground: r.avatar_background,
          avatarColor: r.avatar_color,
          subscription: r.subscription || { tier: 'free' },
        })));
        setDreamResults([]);
      } else {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const dreamOr = wordBound
          ? `content.~*.\\m${escaped}\\M,ai_title.~*.\\m${escaped}\\M,title.~*.\\m${escaped}\\M`
          : `content.ilike.${lower},ai_title.ilike.${lower},title.ilike.${lower}`;
        const { data } = await supabase
          .from('dreams')
          .select('*')
          .in('visibility', ['public', 'anonymous'])
          .or(dreamOr)
          .neq('user_id', currentUserId || '00000000-0000-0000-0000-000000000000')
          .order('created_at', { ascending: false })
          .limit(24);
        setDreamResults((data || []).map(mapDream));
        setUserResults([]);
      }
    } catch {
      setToast('Search hiccup. Please try again.');
    } finally {
      setLoading(false);
      setPending(false);
    }
  };

  const searching = loading || pending;

  const handleProfileNavigation = (profile) => {
    if (!profile?.id) return;
    void triggerLightHaptic();
    navigate(buildProfilePath(profile.username, profile.id));
  };

  const handleDreamNavigation = (dream) => {
    if (!dream?.id) return;
    void triggerLightHaptic();
    const path = dream.visibility === 'anonymous'
      ? `/dream/${dream.id}`
      : buildDreamPath(dream.authorUsername, dream.userId, dream.id);
    navigate(path, { state: { fromNav: '/search' } });
  };

  const renderDream = (dream) => {
    const title = dream.title || (dream.aiGenerated ? dream.aiTitle?.trim() : '');
    const dateLabel = dream.createdAt ? formatDreamDate(dream.createdAt) : 'Recent';
    return (
      <div className="search-dream-card" key={dream.id} role="button" tabIndex={0}
        onClick={() => handleDreamNavigation(dream)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleDreamNavigation(dream); } }}>
        <div className="search-dream-meta">
          <span className="pill">{dateLabel}</span>
          <span className={`pill search-vis--${dream.visibility === 'anonymous' ? 'anonymous' : 'public'}`}>{dream.visibility === 'anonymous' ? 'Anonymous dream' : 'Public dream'}</span>
        </div>
        {title
          ? <h3>{highlightSnippet(title, lastTerm, 120)}</h3>
          : <p className="pending-title">Untitled dream</p>}
        {dream.aiGenerated && dream.aiInsights && <p className="dream-summary">{dream.aiInsights}</p>}
        <p className="dream-snippet">{highlightSnippet(dream.content, lastTerm, 200)}</p>
        {dream.tags?.length ? (
          <div className="dream-tags">
            {dream.tags.map((tag, idx) => <span className="tag" key={`${dream.id}-tag-${idx}`}>{tag.value}</span>)}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
    <div className="page-container stream-page">
      <div className="page-header search-header">
        <div>
          <h1>Search</h1>
          <p className="page-subtitle">Find people and explore public dreams.</p>
        </div>
      </div>
      <div className="search-box card-shell">
        <div className="filter-toggle">
          <span className="filter-label">Filter by:</span>
          {filters.map((option) => (
            <button key={option.id} className={filter === option.id ? 'chip chip-active' : 'chip'} onClick={() => { if (filter !== option.id) void triggerSelectionHaptic(); setFilter(option.id); }} type="button" aria-pressed={filter === option.id}>
              {option.label}
            </button>
          ))}
        </div>
        <form className="search-input-wrap" onSubmit={(e) => { e.preventDefault(); runSearch(); }}>
          <input type="search" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
            aria-label={filter === 'people' ? 'Search people' : 'Search public dreams'}
            enterKeyHint="search"
            placeholder={filter === 'people' ? 'Search names or usernames' : 'Search public dream titles or text'} />
          <button type="submit" className="primary-btn" disabled={loading || searchTerm.trim().length < MIN_CHARS}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>
        <p className="hint">Type at least {MIN_CHARS} characters. Filter to search only people or only public dreams.</p>
      </div>


      {searchTerm.trim().length < MIN_CHARS && !searching ? (
        <div className="empty-state">Start typing to explore {filter === 'people' ? 'people' : 'public dreams'}.</div>
      ) : (
        <div className="search-results">
          {filter === 'people' ? (
            <section className="result-section">
              <div className="section-head"><h2>People</h2><span className="pill">{userResults.length}</span></div>
              {searching ? (
                <SearchPeopleSkeleton />
              ) : userResults.length === 0 ? (
                <div className="placeholder">No matching people.</div>
              ) : (
                <div className="people-grid">
                  {userResults.map((u) => (
                    <div className="person-card" key={u.id} role="button" tabIndex={0}
                      onClick={() => handleProfileNavigation(u)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleProfileNavigation(u); } }}>
                      <AvatarDisplay
                        photoURL={u.photoURL}
                        avatarIcon={u.avatarIcon}
                        avatarBackground={u.avatarBackground || DEFAULT_AVATAR_BACKGROUND}
                        avatarColor={u.avatarColor || DEFAULT_AVATAR_COLOR}
                        className="person-avatar"
                      />
                      <div>
                        <div className="person-name">
                          {u.displayName || 'Dreamer'}
                          <ProBadge subscription={u.subscription} />
                        </div>
                        {u.username && <div className="person-username">@{u.username}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <section className="result-section">
              <div className="section-head"><h2>Public dreams</h2><span className="pill">{dreamResults.length}</span></div>
              {searching ? (
                <SearchDreamsSkeleton />
              ) : dreamResults.length === 0 ? (
                <div className="placeholder">No dreams matched &ldquo;{lastTerm}&rdquo;.</div>
              ) : (
                <div className="dream-grid">{dreamResults.map(renderDream)}</div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
    {toast && <Toast message={toast} onDismiss={() => setToast(null)} duration={5000} />}
    </>
  );
}

Search.propTypes = { user: appUserPropType };
