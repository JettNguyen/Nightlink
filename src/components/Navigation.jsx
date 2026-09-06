import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { faBook, faCompass, faSearch, faUser, faBell, faChevronLeft, faGear, faEllipsisVertical } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import './Navigation.css';
import { appUserPropType, activityPreviewPropType } from '../propTypes';
import { persistFeedSeenTimestamp } from '../services/UserService';
import { triggerLightHaptic } from '../utils/haptics';

const COMPACT_ENTER = 110;
const COMPACT_EXIT = 40;
const getWin = () => (typeof globalThis !== 'undefined' ? globalThis.window : undefined);
const isNativeIOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

function Navigation({ user, activityPreview }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(compact);
  const iosHeaderRef = useRef(null);
  const iosLastScrollYRef = useRef(0);
  const iosHeaderCompactRef = useRef(false);

  // Tab root paths, where the back button never shows
  const TAB_PATHS = new Set(['/journal', '/feed', '/search', '/activity', '/profile']);

  // Show back button only when on a non-tab page that was navigated to via router push.
  // location.key is 'default' on initial/direct load; unique string on any push.
  const canGoBack = isNativeIOS
    && location.key !== 'default'
    && !TAB_PATHS.has(location.pathname);

  const showHeaderSettings = isNativeIOS && location.pathname === '/profile';
  const showHeaderProfileMenu = useMemo(() => {
    if (!isNativeIOS) return false;

    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[0] !== 'profile') return false;

    const handle = (parts[1] || '').toLowerCase();
    if (!handle) return false;

    const reserved = new Set(['edit', 'connections', 'settings']);
    if (reserved.has(handle)) return false;

    const ownUid = (user?.uid || '').toLowerCase();
    if (ownUid && handle === ownUid) return false;

    return true;
  }, [location.pathname, user?.uid]);

  const handleBack = useCallback(() => {
    void triggerLightHaptic();
    navigate(-1);
  }, [navigate]);

  const handleGoSettings = useCallback(() => {
    void triggerLightHaptic();
    navigate('/settings');
  }, [navigate]);

  const handleOpenProfileMenu = useCallback(() => {
    void triggerLightHaptic();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nightlink:open-profile-menu'));
    }
  }, []);

  const viewerId = user?.uid || '';
  const inbox = activityPreview?.inboxEntries ?? [];
  const unreadCount = activityPreview?.unreadActivityCount ?? inbox.filter((e) => !e?.read).length;
  const hasUnread = activityPreview?.hasUnreadActivity ?? unreadCount > 0;
  const updates = activityPreview?.followingUpdates ?? [];
  const latestTs = activityPreview?.latestFollowingTimestamp || 0;
  const remoteFeedSeenAt = activityPreview?.feedSeenAt ?? 0;
  const storageKey = `nightlink:feedSeen:${viewerId || 'anon'}`;

  const readLocalFeedSeenAt = () => {
    const w = getWin();
    if (!w) return 0;
    try { return Number(w.localStorage.getItem(storageKey)) || 0; }
    catch { return 0; }
  };

  const [localFeedSeenAt, setLocalFeedSeenAt] = useState(() => readLocalFeedSeenAt());

  useEffect(() => {
    setLocalFeedSeenAt(readLocalFeedSeenAt());
  }, [storageKey]);

  const persistLocalFeedSeenAt = useCallback((value) => {
    setLocalFeedSeenAt(value);
    const w = getWin();
    if (!w) return;
    try { w.localStorage.setItem(storageKey, String(value)); } catch {
      // localStorage unavailable (private mode or quota); ignore markers
    }
  }, [storageKey]);

  useEffect(() => {
    if (remoteFeedSeenAt > localFeedSeenAt) {
      persistLocalFeedSeenAt(remoteFeedSeenAt);
    }
  }, [remoteFeedSeenAt, localFeedSeenAt, persistLocalFeedSeenAt]);

  const effectiveFeedSeenAt = Math.max(localFeedSeenAt, remoteFeedSeenAt);

  const newFeedCount = useMemo(() => {
    const count = updates.reduce((n, e) => {
      const t = (e.updatedAt || e.createdAt)?.getTime?.() || 0;
      return t > effectiveFeedSeenAt ? n + 1 : n;
    }, 0);
    return count > 0 ? count : (latestTs > effectiveFeedSeenAt ? 1 : 0);
  }, [updates, effectiveFeedSeenAt, latestTs]);

  const hasNewFeed = newFeedCount > 0;

  const markFeedSeen = useCallback(() => {
    const ref = Math.max(latestTs, Date.now());
    persistLocalFeedSeenAt(ref);
    if (viewerId) {
      persistFeedSeenTimestamp(viewerId, ref).catch(() => {});
    }
  }, [latestTs, viewerId, persistLocalFeedSeenAt]);

  const markAllInboxRead = activityPreview?.markAllInboxRead;

  const fromNav = location.state?.fromNav;

  const currentPath = useMemo(() => {
    const p = location.pathname;
    if (p.startsWith('/dream')) return fromNav || '/journal';
    if (p.startsWith('/journal')) return '/journal';
    if (p.startsWith('/feed')) return '/feed';
    if (p.startsWith('/search')) return '/search';
    if (p.startsWith('/activity')) return '/activity';
    if (p.startsWith('/profile')) return '/profile';
    return p;
  }, [location.pathname, fromNav]);

  const isActive = (path) => currentPath === path ? 'active' : '';

  const handleNavTap = useCallback((path, sideEffect) => () => {
    void triggerLightHaptic();
    // Re-tapping the current tab returns to the top, the way a native tab bar
    // does. `scroll-behavior: smooth` on the root keeps it eased.
    if (path === currentPath) {
      const w = getWin();
      if (w && w.scrollY > 0) w.scrollTo(0, 0);
    }
    sideEffect?.();
  }, [currentPath]);

  useEffect(() => {
    if (currentPath === '/feed') markFeedSeen();
  }, [currentPath, markFeedSeen]);

  useEffect(() => {
    if (currentPath === '/activity') markAllInboxRead?.();
  }, [currentPath, markAllInboxRead]);

  useEffect(() => { compactRef.current = compact; }, [compact]);

  // Web-only: compact scroll behaviour for top nav
  useEffect(() => {
    if (isNativeIOS) return;
    const w = getWin();
    if (!w) return;
    let ticking = false;

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      w.requestAnimationFrame(() => {
        const y = w.scrollY || 0;
        if (!compactRef.current && y > COMPACT_ENTER) setCompact(true);
        else if (compactRef.current && y < COMPACT_EXIT) setCompact(false);
        ticking = false;
      });
    };

    onScroll();
    w.addEventListener('scroll', onScroll, { passive: true });
    return () => w.removeEventListener('scroll', onScroll);
  }, []);

  // iOS-only: compact/expand header on scroll direction.
  // Compact = translateY(-52px): content slides up, safe-area bar stays visible under dynamic island.
  // We set transition timing inline before the transform so collapse (fast ease-in) and
  // expand (spring) use different curves without CSS class order conflicts.
  useEffect(() => {
    if (!isNativeIOS) return;
    const w = getWin();
    if (!w) return;
    let ticking = false;
    const THRESHOLD = 10;

    const setCompact = (compact) => {
      const el = iosHeaderRef.current;
      if (!el) return;
      const left = el.querySelector('.nav-ios-header-left');
      const center = el.querySelector('.nav-ios-header-center');
      const right = el.querySelector('.nav-ios-header-right');
      if (compact) {
        el.style.transitionDuration = '0.22s';
        el.style.transitionTimingFunction = 'cubic-bezier(0.4, 0, 0.6, 1)';
        el.style.transform = 'translateY(-52px)';
        [left, center, right].forEach((node) => {
          if (!node) return;
          node.style.opacity = '0';
          node.style.transition = 'opacity 0.12s ease';
        });
      } else {
        el.style.transitionDuration = '0.38s';
        el.style.transitionTimingFunction = 'cubic-bezier(0.22, 1, 0.36, 1)';
        el.style.transform = 'translateY(0px)';
        [left, center, right].forEach((node) => {
          if (!node) return;
          node.style.transition = 'opacity 0.22s ease 0.1s';
          node.style.opacity = '1';
        });
      }
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      w.requestAnimationFrame(() => {
        const y = w.scrollY || 0;
        const delta = y - iosLastScrollYRef.current;

        if (y <= 10) {
          if (iosHeaderCompactRef.current) {
            iosHeaderCompactRef.current = false;
            setCompact(false);
          }
        } else if (delta > THRESHOLD && !iosHeaderCompactRef.current) {
          iosHeaderCompactRef.current = true;
          setCompact(true);
        } else if (delta < -THRESHOLD && iosHeaderCompactRef.current) {
          iosHeaderCompactRef.current = false;
          setCompact(false);
        }

        iosLastScrollYRef.current = y;
        ticking = false;
      });
    };

    w.addEventListener('scroll', onScroll, { passive: true });
    return () => w.removeEventListener('scroll', onScroll);
  }, []);

  if (isNativeIOS) {
    return (
      <>
        <header ref={iosHeaderRef} className="nav-ios-header">
          <div className="nav-ios-header-side nav-ios-header-left">
            {canGoBack && (
              <button type="button" className="nav-ios-back-btn" onClick={handleBack} aria-label="Go back">
                <FontAwesomeIcon icon={faChevronLeft} />
              </button>
            )}
          </div>
          <div className="nav-ios-header-center">
            <img src="/favicon.svg" alt="" className="nav-ios-logo-icon" />
            <span className="nav-ios-logo-text">Nightlink</span>
          </div>
          <div className="nav-ios-header-side nav-ios-header-right">
            {showHeaderSettings && (
              <button type="button" className="nav-ios-back-btn" onClick={handleGoSettings} aria-label="Settings">
                <FontAwesomeIcon icon={faGear} />
              </button>
            )}
            {showHeaderProfileMenu && (
              <button type="button" className="nav-ios-back-btn" onClick={handleOpenProfileMenu} aria-label="Profile actions">
                <FontAwesomeIcon icon={faEllipsisVertical} />
              </button>
            )}
          </div>
        </header>

        <nav className="nav-ios-tabbar">
          <Link to="/journal" aria-label="Journal" aria-current={isActive('/journal') ? 'page' : undefined} className={`nav-ios-tab${isActive('/journal') ? ' active' : ''}`} onClick={handleNavTap('/journal')}>
            <span className="nav-icon-wrapper">
              <FontAwesomeIcon icon={faBook} className="nav-icon" />
            </span>
          </Link>
          <Link to="/feed" aria-label="Feed" aria-current={isActive('/feed') ? 'page' : undefined} className={`nav-ios-tab${isActive('/feed') ? ' active' : ''}`} onClick={handleNavTap('/feed', markFeedSeen)}>
            <span className="nav-icon-wrapper">
              <FontAwesomeIcon icon={faCompass} className="nav-icon" />
              {hasNewFeed && (
                <span className="nav-activity-indicator" aria-label={`${newFeedCount} new`}>
                  {newFeedCount > 9 ? '9+' : newFeedCount}
                </span>
              )}
            </span>
          </Link>
          <Link to="/search" aria-label="Search" aria-current={isActive('/search') ? 'page' : undefined} className={`nav-ios-tab${isActive('/search') ? ' active' : ''}`} onClick={handleNavTap('/search')}>
            <span className="nav-icon-wrapper">
              <FontAwesomeIcon icon={faSearch} className="nav-icon" />
            </span>
          </Link>
          <Link to="/activity" aria-label="Activity" aria-current={isActive('/activity') ? 'page' : undefined} className={`nav-ios-tab${isActive('/activity') ? ' active' : ''}`} onClick={handleNavTap('/activity')}>
            <span className="nav-icon-wrapper">
              <FontAwesomeIcon icon={faBell} className="nav-icon" />
              {hasUnread && (
                <span className="nav-activity-indicator" aria-label={`${unreadCount} unread`}>
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </span>
          </Link>
          <Link to="/profile" aria-label="Profile" aria-current={isActive('/profile') ? 'page' : undefined} className={`nav-ios-tab${isActive('/profile') ? ' active' : ''}`} onClick={handleNavTap('/profile')}>
            <span className="nav-icon-wrapper">
              <FontAwesomeIcon icon={faUser} className="nav-icon" />
            </span>
          </Link>
        </nav>
      </>
    );
  }

  return (
    <nav className={`navigation${compact ? ' navigation-compact' : ''}`}>
      <div className="nav-container">
        <Link to="/journal" className="nav-logo">
          <img src="/favicon.svg" alt="" className="nav-logo-icon" />
          <span>Nightlink</span>
        </Link>

        <div className="nav-links">
          <Link to="/journal" aria-label="Journal" aria-current={isActive('/journal') ? 'page' : undefined} className={isActive('/journal')} onClick={handleNavTap('/journal')}>
            <span className="nav-icon-wrapper">
              <FontAwesomeIcon icon={faBook} className="nav-icon" />
            </span>
            <span className="nav-tab-label">Journal</span>
          </Link>
          <Link to="/feed" aria-label="Feed" aria-current={isActive('/feed') ? 'page' : undefined} className={isActive('/feed')} onClick={handleNavTap('/feed', markFeedSeen)}>
            <span className="nav-icon-wrapper">
              <FontAwesomeIcon icon={faCompass} className="nav-icon" />
              {hasNewFeed && (
                <span className="nav-activity-indicator" aria-label={`${newFeedCount} new`}>
                  {newFeedCount > 9 ? '9+' : newFeedCount}
                </span>
              )}
            </span>
            <span className="nav-tab-label">Feed</span>
          </Link>
          <Link to="/search" aria-label="Search" aria-current={isActive('/search') ? 'page' : undefined} className={isActive('/search')} onClick={handleNavTap('/search')}>
            <span className="nav-icon-wrapper">
              <FontAwesomeIcon icon={faSearch} className="nav-icon" />
            </span>
            <span className="nav-tab-label">Search</span>
          </Link>
          <Link to="/activity" aria-label="Activity" aria-current={isActive('/activity') ? 'page' : undefined} className={isActive('/activity')} onClick={handleNavTap('/activity')}>
            <span className="nav-icon-wrapper">
              <FontAwesomeIcon icon={faBell} className="nav-icon" />
              {hasUnread && (
                <span className="nav-activity-indicator" aria-label={`${unreadCount} unread`}>
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </span>
            <span className="nav-tab-label">Activity</span>
          </Link>
          <Link to="/profile" aria-label="Profile" aria-current={isActive('/profile') ? 'page' : undefined} className={isActive('/profile')} onClick={handleNavTap('/profile')}>
            <span className="nav-icon-wrapper">
              <FontAwesomeIcon icon={faUser} className="nav-icon" />
            </span>
            <span className="nav-tab-label">Profile</span>
          </Link>
        </div>
      </div>
    </nav>
  );
}

export default Navigation;

Navigation.propTypes = {
  user: appUserPropType,
  activityPreview: activityPreviewPropType
};
