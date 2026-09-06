import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useNavigationType, useParams } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import PropTypes from 'prop-types';
import { Capacitor } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { supabase } from './supabase';
import AuthPage from './pages/AuthPage';
import HomePage from './pages/HomePage';
import DreamJournal from './pages/DreamJournal';
import DreamDetail from './pages/DreamDetail';
import Feed from './pages/Feed';
import Navigation from './components/Navigation';
import OfflineIndicator from './components/OfflineIndicator';
import KeyboardDismiss from './components/KeyboardDismiss';
import LoadingIndicator from './components/LoadingIndicator';
import ErrorBoundary from './components/ErrorBoundary';
import useActivityPreview from './hooks/useActivityPreview';
import { pushActivityLocalNotification, syncDailyDreamReminder } from './utils/notificationHelpers';
import { triggerMediumHaptic, triggerSuccessHaptic } from './utils/haptics';
import { initIosTapFix } from './utils/iosTapFix';
import { requestRefresh } from './hooks/useRefreshSignal';
import { appUserPropType } from './propTypes';
import TermsGate, { isTermsAccepted, markTermsAccepted, TERMS_VERSION } from './components/TermsGate';
import { SubscriptionContext } from './contexts/SubscriptionContext';
import {
  IS_RC_SUPPORTED,
  configurePurchases,
  getCustomerInfo,
  addCustomerInfoUpdateListener,
  removeCustomerInfoUpdateListener,
  syncCustomerInfoToSupabase,
} from './utils/purchases';

const DEFAULT_API_ORIGIN = 'https://www.nightlink.dev';
const resolveAccountEndpoint = () => {
  const ep = (import.meta.env.VITE_ACCOUNT_ENDPOINT || '').trim();
  if (ep) return ep;
  const base = (import.meta.env.VITE_API_BASE_URL || '').trim();
  if (base) return `${base.replace(/\/$/, '')}/api/account`;
  if (Capacitor.isNativePlatform()) return `${DEFAULT_API_ORIGIN}/api/account`;
  return '/api/account';
};
const ACCOUNT_ENDPOINT = resolveAccountEndpoint();

// Every full-screen overlay in the app. Pull-to-refresh reloads the page, so it
// has to stand down whenever one of these is up, because otherwise dragging on a
// confirm sheet or the photo cropper throws away what the user was doing.
const MODAL_SELECTOR = [
  '.report-modal-backdrop',
  '.modal-overlay',
  '.confirm-modal-backdrop',
  '.crop-modal-backdrop',
  // Only matches while a recording is actually in flight. Reloading the page
  // mid-dictation would throw the audio away.
  '.voice-input.is-recording',
].join(', ');

/**
 * Resolves the tier the server considers this account to be on, and returns it.
 *
 * The server knows things the client cannot: a comped email is premium there
 * but reads as free from the profile row alone. The response was being thrown
 * away, so a comped user was shown "upgrade to Pro" until their first
 * generation came back and corrected it. Returns null when the answer is
 * unknown, whether offline, failed, or not signed in, which callers treat as "do not
 * claim anything about this account yet".
 */
const syncSubscriptionTier = async (session) => {
  if (!session) return null;
  try {
    const idToken = session.access_token;
    if (!idToken) return null;
    const response = await fetch(ACCOUNT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ action: 'sync_subscription_tier', uid: session.user.id }),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    if (payload?.tier === 'premium') return 'premium';
    if (payload?.tier === 'free') return 'free';
    return null;
  } catch {
    // Non-critical, so silently ignore network errors on startup
    return null;
  }
};

const Profile = lazy(() => import('./pages/Profile'));
const Connections = lazy(() => import('./pages/Connections'));
const EditProfile = lazy(() => import('./pages/EditProfile'));
const Search = lazy(() => import('./pages/Search'));
const Activity = lazy(() => import('./pages/Activity'));
const Settings = lazy(() => import('./pages/Settings'));
const DreamInsights = lazy(() => import('./pages/DreamInsights'));
const TermsOfUse = lazy(() => import('./pages/TermsOfUse'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));

// Tab roots cross-fade instead of sliding, matching how a native tab bar behaves.
const TAB_ROOT_PATHS = new Set(['/journal', '/feed', '/search', '/activity', '/profile']);

function ProtectedRoute({ user, children }) {
  return user ? children : <Navigate to="/login" replace />;
}

function LazyRouteLoader() {
  return (
    <div className="lazy-route-loading">
      <LoadingIndicator label="Loading…" size="md" />
    </div>
  );
}

// React Router keeps the window scroll offset across navigations, so opening a
// dream from halfway down the feed lands mid-page. Back/forward (POP) is left
// alone so the browser can restore where the user actually was.
function ScrollToTop() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType === 'POP') return;
    // `behavior: 'instant'` throws on iOS < 15.4 (invalid enum), and the plain
    // call would inherit `scroll-behavior: smooth` from the stylesheet, so
    // briefly force `auto` on the root instead. Instant scrolls are synchronous.
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    root.style.scrollBehavior = previous;
  }, [pathname, navigationType]);

  return null;
}

function LegacyRedirect() {
  const { dreamId } = useParams();
  return <Navigate to={`/dream/${dreamId}`} replace />;
}

function AppContent({ user, loading, ready }) {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const [termsAccepted, setTermsAccepted] = useState(() => isTermsAccepted());
  const showNav = user && pathname !== '/login' && termsAccepted;

  // If localStorage was cleared (e.g. iOS WKWebView eviction), restore acceptance
  // from the user's Supabase profile so they don't have to re-accept every login.
  useEffect(() => {
    if (!user?.uid || termsAccepted) return;
    supabase
      .from('profiles')
      .select('settings')
      .eq('id', user.uid)
      .single()
      .then(({ data }) => {
        if (data?.settings?.termsVersion === TERMS_VERSION) {
          markTermsAccepted();
          setTermsAccepted(true);
        }
      })
      .catch(() => {});
  }, [user?.uid, termsAccepted]);
  const mainClassName = showNav ? 'app-main app-main--with-nav' : 'app-main app-main--no-nav';

  // Drives the iOS page transition. Switching tabs is a lateral move, so it
  // cross-fades the way a native tab bar does; everything else is a push or a
  // pop and slides in from the side it came from. Set as a prop on <main> so the
  // attribute lands in the same commit as the incoming page, which a layout
  // effect could not guarantee before the animation's first frame.
  const navDirection = useMemo(() => {
    if (TAB_ROOT_PATHS.has(pathname)) return 'tab';
    return navigationType === 'POP' ? 'back' : 'forward';
  }, [pathname, navigationType]);
  const home = useMemo(() => (user ? '/journal' : '/'), [user]);
  const activity = useActivityPreview(user?.uid);
  const isNativeIOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
  const seenActivityNotificationIdsRef = useRef(new Set());
  const activityHydratedRef = useRef(false);
  const startupBusyRef = useRef(true);
  const lastPullRefreshAtRef = useRef(0);
  const pullStartYRef = useRef(0);
  const pullDistanceRef = useRef(0);
  const pullActiveRef = useRef(false);
  const pullReadyRef = useRef(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      startupBusyRef.current = false;
    }, 1200);
    return () => clearTimeout(timer);
  }, []);

  const pullRefreshEnabled = isNativeIOS && !['/', '/login', '/terms', '/privacy'].includes(pathname);

  useEffect(() => {
    if (!pullRefreshEnabled) return undefined;

    // How far the user must drag before the indicator appears at all.
    const GRAPHIC_DEAD_ZONE = 50;
    // How far past the dead zone before refresh fires (total raw drag = dead zone + this).
    const PULL_THRESHOLD = 130;
    // Maximum dampened travel shown to the indicator.
    const MAX_PULL_DISTANCE = 180;
    const REFRESH_COOLDOWN_MS = 2000;
    const initialLastRefresh = Number(sessionStorage.getItem('nightlink_last_pull_refresh') || '0');
    if (initialLastRefresh > 0) {
      lastPullRefreshAtRef.current = initialLastRefresh;
    }

    const setDistanceSafely = (value) => {
      pullDistanceRef.current = value;
      setPullDistance(value);
    };

    const isInsideScrollable = (el) => {
      let node = el instanceof Element ? el.parentElement : null;
      while (node && node !== document.body) {
        const { overflowY } = window.getComputedStyle(node);
        if (overflowY === 'auto' || overflowY === 'scroll') return true;
        node = node.parentElement;
      }
      return false;
    };

    const onTouchStart = (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (isInsideScrollable(target)) return;
      if (document.querySelector(MODAL_SELECTOR)) return;
      // With the keyboard up a downward drag is someone dismissing it, not
      // asking for a refresh.
      if (document.documentElement.classList.contains('keyboard-open')) return;
      // Only arm PTR when the page is truly at the top at touch-start.
      if (window.scrollY > 2) return;
      if (!event.touches || event.touches.length !== 1) return;
      pullStartYRef.current = event.touches[0].clientY;
      pullActiveRef.current = true;
      pullReadyRef.current = false;
      setDistanceSafely(0);
    };

    const onTouchMove = (event) => {
      if (!pullActiveRef.current) return;
      if (document.querySelector(MODAL_SELECTOR)) {
        pullActiveRef.current = false;
        setDistanceSafely(0);
        return;
      }
      // Cancel if the page has scrolled down, since the user is scrolling and not pulling.
      // Use > 4 to tolerate iOS sub-pixel scroll jitter without false cancels.
      if (window.scrollY > 4) {
        pullActiveRef.current = false;
        setDistanceSafely(0);
        return;
      }
      const currentY = event.touches?.[0]?.clientY ?? pullStartYRef.current;
      const rawDelta = currentY - pullStartYRef.current;
      if (rawDelta <= 0) {
        setDistanceSafely(0);
        return;
      }

      // Dead zone: first GRAPHIC_DEAD_ZONE px of drag are invisible: no graphic,
      // no haptic. This matches how Twitter/Instagram handle accidental micro-pulls.
      const past = rawDelta - GRAPHIC_DEAD_ZONE;
      if (past <= 0) {
        setDistanceSafely(0);
        return;
      }

      // Rubber-band damping: resistance increases the further you pull,
      // exactly like iOS native PTR. Formula: progress^0.6 gives a
      // natural decelerating feel without a hard cap feeling abrupt.
      const progress = Math.min(1, past / PULL_THRESHOLD);
      const dampened = Math.round(MAX_PULL_DISTANCE * Math.pow(progress, 0.6));
      const isReady = past >= PULL_THRESHOLD;

      if (isReady !== pullReadyRef.current) {
        pullReadyRef.current = isReady;
        if (isReady) void triggerMediumHaptic();
      }

      setDistanceSafely(dampened);
    };

    const onTouchEnd = () => {
      if (!pullActiveRef.current) return;
      // Use the raw distance tracked via pullReadyRef, which is more reliable than
      // checking pullDistanceRef which holds the dampened visual value.
      const shouldRefresh = pullReadyRef.current;
      pullActiveRef.current = false;
      pullReadyRef.current = false;
      setDistanceSafely(0);

      if (!shouldRefresh) return;

      const now = Date.now();
      if (now - lastPullRefreshAtRef.current < REFRESH_COOLDOWN_MS) return;
      lastPullRefreshAtRef.current = now;
      sessionStorage.setItem('nightlink_last_pull_refresh', String(now));

      // Soft refresh: ask the mounted pages to re-fetch rather than reloading
      // the document. The indicator holds briefly so the gesture resolves
      // visibly even when the data comes back instantly.
      setRefreshing(true);
      void triggerSuccessHaptic();
      requestRefresh();
      window.setTimeout(() => setRefreshing(false), 650);
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [pullRefreshEnabled]);

  useEffect(() => {
    const settings = activity?.viewerProfile?.settings || {};
    const enabled = Boolean(settings.notificationsEnabled && settings.notifyDreamReminders);
    const hour = settings.reminderHour ?? 9;

    const delay = startupBusyRef.current ? 900 : 0;
    const timer = setTimeout(() => {
      syncDailyDreamReminder(enabled, hour).catch((error) => {
        console.error('Dream reminder sync failed', error);
      });
    }, delay);

    return () => clearTimeout(timer);
  }, [
    activity?.viewerProfile?.settings?.notificationsEnabled,
    activity?.viewerProfile?.settings?.notifyDreamReminders,
    activity?.viewerProfile?.settings?.reminderHour,
  ]);

  useEffect(() => {
    const entries = activity?.inboxEntries || [];
    const settings = activity?.viewerProfile?.settings || {};
    const enabled = Boolean(settings.notificationsEnabled && settings.notifyActivityAlerts);

    if (!activityHydratedRef.current) {
      entries.forEach((entry) => {
        if (entry?.id) seenActivityNotificationIdsRef.current.add(entry.id);
      });
      activityHydratedRef.current = true;
      return;
    }

    if (!enabled) {
      entries.forEach((entry) => {
        if (entry?.id) seenActivityNotificationIdsRef.current.add(entry.id);
      });
      return;
    }

    const unseenUnread = entries.filter((entry) => (
      entry?.id
      && entry.read === false
      && !seenActivityNotificationIdsRef.current.has(entry.id)
    ));

    const delay = startupBusyRef.current ? 1000 : 0;
    const timer = setTimeout(() => {
      unseenUnread.slice(0, 4).forEach((entry) => {
        seenActivityNotificationIdsRef.current.add(entry.id);
        pushActivityLocalNotification(entry).catch((error) => {
          console.error('Activity local notification failed', error);
        });
      });
    }, delay);

    return () => clearTimeout(timer);
  }, [
    activity?.inboxEntries,
    activity?.viewerProfile?.settings?.notificationsEnabled,
    activity?.viewerProfile?.settings?.notifyActivityAlerts,
  ]);

  if (loading) {
    return (
      <div className="app-loading-shell">
        <LoadingIndicator label="Loading your space…" size="lg" />
      </div>
    );
  }

  if (ready && !user && !['/', '/login', '/terms', '/privacy'].includes(pathname)) {
    return <Navigate to="/login" replace />;
  }

  // Authenticated but hasn't accepted terms yet, so gate everything except /terms and /privacy
  if (user && !termsAccepted) {
    return (
      <div className="app">
        <Suspense fallback={<LazyRouteLoader />}>
          <Routes>
            <Route path="/terms" element={<TermsOfUse />} />
            <Route path="/privacy" element={<PrivacyPolicy />} />
            <Route path="*" element={<TermsGate onAccepted={() => {
              setTermsAccepted(true);
              // Persist to Supabase so acceptance survives localStorage eviction on iOS.
              if (user?.uid) {
                supabase
                  .from('profiles')
                  .select('settings')
                  .eq('id', user.uid)
                  .single()
                  .then(({ data }) => {
                    const updated = { ...(data?.settings || {}), termsVersion: TERMS_VERSION };
                    return supabase.from('profiles').update({ settings: updated }).eq('id', user.uid);
                  })
                  .catch(() => {});
              }
            }} />} />
          </Routes>
        </Suspense>
      </div>
    );
  }

  const wrap = (Component) => (
    <ProtectedRoute user={user}><Component user={user} /></ProtectedRoute>
  );

  return (
    <div className="app">
      {pullRefreshEnabled && (
        <div
          className={`pull-refresh-indicator${(pullDistance >= 50 || refreshing) ? ' is-visible' : ''}${pullDistance >= 180 ? ' is-armed' : ''}${refreshing ? ' is-refreshing' : ''}`}
          style={{ '--pull-progress': String(refreshing ? 1 : Math.min(1, pullDistance / 180)) }}
          role="status"
          aria-live="polite"
        >
          {refreshing ? 'Refreshing…' : pullDistance >= 180 ? 'Release to refresh' : 'Pull to refresh'}
        </div>
      )}
      <OfflineIndicator />
      <KeyboardDismiss />
      {showNav && <Navigation user={user} activityPreview={activity} />}
    <main className={mainClassName} data-nav-direction={navDirection} style={{ minHeight: '100dvh' }}>
        <Routes>
          <Route path="/" element={user ? <Navigate to="/journal" replace /> : <HomePage />} />
          <Route path="/login" element={user ? <Navigate to="/journal" replace /> : <AuthPage />} />
          <Route path="/terms" element={<Suspense fallback={<LazyRouteLoader />}><TermsOfUse /></Suspense>} />
          <Route path="/privacy" element={<Suspense fallback={<LazyRouteLoader />}><PrivacyPolicy /></Suspense>} />
          <Route path="/journal" element={wrap(DreamJournal)} />
          <Route path="/profile/:handle/dream/:dreamId" element={wrap(DreamDetail)} />
          <Route path="/dream/:dreamId" element={wrap(DreamDetail)} />
          <Route path="/journal/:dreamId" element={<ProtectedRoute user={user}><LegacyRedirect /></ProtectedRoute>} />
          <Route path="/feed" element={wrap(Feed)} />
          <Route path="/profile" element={
            <ProtectedRoute user={user}>
              <Suspense fallback={<LazyRouteLoader />}>
                <Profile user={user} />
              </Suspense>
            </ProtectedRoute>
          } />
          <Route path="/profile/edit" element={
            <ProtectedRoute user={user}>
              <Suspense fallback={<LazyRouteLoader />}>
                <EditProfile user={user} />
              </Suspense>
            </ProtectedRoute>
          } />
          <Route path="/profile/connections" element={
            <ProtectedRoute user={user}>
              <Suspense fallback={<LazyRouteLoader />}>
                <Connections user={user} />
              </Suspense>
            </ProtectedRoute>
          } />
          <Route path="/profile/:handle/connections" element={
            <ProtectedRoute user={user}>
              <Suspense fallback={<LazyRouteLoader />}>
                <Connections user={user} />
              </Suspense>
            </ProtectedRoute>
          } />
          <Route path="/profile/:handle" element={
            <ProtectedRoute user={user}>
              <Suspense fallback={<LazyRouteLoader />}>
                <Profile user={user} />
              </Suspense>
            </ProtectedRoute>
          } />
          <Route path="/search" element={
            <ProtectedRoute user={user}>
              <Suspense fallback={<LazyRouteLoader />}>
                <Search user={user} />
              </Suspense>
            </ProtectedRoute>
          } />
          <Route path="/settings" element={
            <ProtectedRoute user={user}>
              <Suspense fallback={<LazyRouteLoader />}>
                <Settings user={user} />
              </Suspense>
            </ProtectedRoute>
          } />
          <Route
            path="/activity"
            element={
              <ProtectedRoute user={user}>
                <Suspense fallback={<LazyRouteLoader />}>
                  <Activity user={user} activityPreview={activity} />
                </Suspense>
              </ProtectedRoute>
            }
          />
          <Route path="/insights" element={
            <ProtectedRoute user={user}>
              <Suspense fallback={<LazyRouteLoader />}>
                <DreamInsights user={user} />
              </Suspense>
            </ProtectedRoute>
          } />
          <Route path="/notifications" element={<Navigate to="/activity" replace />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
    </div>
  );
}

// Build a normalized user object with the same shape the rest of the app expects.
const buildNormalizedUser = (session) => {
  if (!session) return null;
  const { user, access_token } = session;
  return {
    uid: user.id,
    email: user.email || '',
    displayName: user.user_metadata?.display_name || user.user_metadata?.full_name || null,
    photoURL: user.user_metadata?.avatar_url || null,
    providerData: (user.identities || []).map((i) => ({ providerId: i.provider })),
    getIdToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token || access_token || null;
    }
  };
};

// Ensure a profile row exists for OAuth (Google) sign-ins.
// Email/password sign-ups create the profile explicitly in AuthPage.jsx.
const ensureProfile = async (session) => {
  if (!session) return;
  const { user } = session;
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', user.id)
    .single();
  if (existing) return;

  // Auto-generate a username from the email prefix
  const emailPrefix = user.email?.split('@')[0] || 'dreamer';
  const base = emailPrefix.replace(/[^a-zA-Z0-9_]/g, '_') || 'dreamer';
  let username = base;
  let counter = 1;
  while (counter <= 5000) {
    const { data: taken } = await supabase
      .from('profiles')
      .select('id')
      .eq('normalized_username', username.toLowerCase())
      .single();
    if (!taken) break;
    username = `${base}${counter}`;
    counter++;
  }

  await supabase.from('profiles').insert({
    id:                 user.id,
    email:              user.email,
    display_name:       user.user_metadata?.full_name || user.user_metadata?.display_name || username,
    username,
    normalized_username: username.toLowerCase(),
    is_anonymous:       false,
    account_visibility: 'private',
    settings:           { accountVisibility: 'private' },
    following_ids:      [],
    follower_ids:       [],
  });
};

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [rcCustomerInfo, setRcCustomerInfo] = useState(null);
  // null until the server has answered: "unknown", not "free".
  const [accountTier, setAccountTier] = useState(null);
  const rcListenerIdRef = useRef(null);

  // Initialize RevenueCat once the user is known (iOS native only).
  // Stores live CustomerInfo in state so any page can read the current tier
  // without an extra Supabase round-trip (avoids stale-tier false negatives).
  useEffect(() => {
    if (!IS_RC_SUPPORTED || !user?.uid) return;

    let cancelled = false;

    const setup = async () => {
      try {
        await configurePurchases(user.uid);
        const customerInfo = await getCustomerInfo();
        if (!cancelled) {
          setRcCustomerInfo(customerInfo);
          syncCustomerInfoToSupabase(user.uid, customerInfo).catch(console.error);
        }
        const callbackId = await addCustomerInfoUpdateListener((info) => {
          if (!cancelled) {
            setRcCustomerInfo(info);
            syncCustomerInfoToSupabase(user.uid, info).catch(console.error);
          }
        });
        if (!cancelled) {
          rcListenerIdRef.current = callbackId;
        } else {
          removeCustomerInfoUpdateListener(callbackId).catch(() => {});
        }
      } catch (err) {
        console.error('RevenueCat setup failed:', err?.message || err);
      }
    };

    setup();

    return () => {
      cancelled = true;
      if (rcListenerIdRef.current) {
        removeCustomerInfoUpdateListener(rcListenerIdRef.current).catch(() => {});
        rcListenerIdRef.current = null;
      }
    };
  }, [user?.uid]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        ensureProfile(session).catch(console.error);
        syncSubscriptionTier(session).then(setAccountTier).catch(console.error);
      }
      setUser(buildNormalizedUser(session));
      setLoading(false);
      setReady(true);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        ensureProfile(session).catch(console.error);
        syncSubscriptionTier(session).then(setAccountTier).catch(console.error);
      }
      setUser(buildNormalizedUser(session));
      setLoading(false);
      setReady(true);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = 'dark'; }, []);

  useEffect(() => initIosTapFix(), []);

  useEffect(() => {
    if (!ready || !Capacitor.isNativePlatform()) return;
    SplashScreen.hide().catch(() => {});
  }, [ready]);

  return (
    <SubscriptionContext.Provider value={{ rcCustomerInfo, setRcCustomerInfo, accountTier }}>
      <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ScrollToTop />
        <ErrorBoundary>
          <AppContent user={user} loading={loading} ready={ready} />
        </ErrorBoundary>
      </Router>
    </SubscriptionContext.Provider>
  );
}

export default App;

ProtectedRoute.propTypes = {
  user: appUserPropType,
  children: PropTypes.node.isRequired
};

AppContent.propTypes = {
  user: appUserPropType,
  loading: PropTypes.bool.isRequired,
  ready: PropTypes.bool.isRequired
};
