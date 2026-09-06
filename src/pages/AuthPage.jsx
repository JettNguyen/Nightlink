import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App as CapacitorApp } from '@capacitor/app';
import { SignInWithApple } from '@capacitor-community/apple-sign-in';
import { supabase } from '../supabase';
import './AuthPage.css';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const NATIVE_OAUTH_REDIRECT = 'dev.nightlink://auth/callback';
const NATIVE_OAUTH_SCHEME = 'dev.nightlink://';
const IS_IOS_NATIVE = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cryptographic nonce helpers for Apple Sign In
const generateRawNonce = () => {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
};
const sha256Hex = async (str) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
};

const friendlyMsg = (e) => {
  const msg = e?.message || '';
  if (!msg) return 'Something went wrong. Please try again.';
  if (msg.includes('username-taken') || msg.includes('already been registered') || msg.includes('User already registered')) return 'That account already exists.';
  if (msg.includes('Invalid login credentials') || msg.includes('invalid_credentials') || msg.includes('username-not-found')) return 'We could not sign you in. Check your details and try again.';
  if (msg.includes('Email not confirmed')) return 'Please confirm your email before signing in.';
  if (msg.includes('identifier-required')) return 'Enter your email or username.';
  return 'Something went wrong. Please try again.';
};

export default function AuthPage() {
  const [searchParams] = useSearchParams();
  // Landing-page "Create account" links through as ?mode=signup so the form
  // opens on the tab the user actually asked for.
  const [mode, setMode] = useState(() => (searchParams.get('mode') === 'signup' ? 'signup' : 'signin'));
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [acceptedPolicies, setAcceptedPolicies] = useState(false);
  const [confirmedAge, setConfirmedAge] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotStatus, setForgotStatus] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const signupRef = useRef(null);
  const signinRef = useRef(null);
  const [height, setHeight] = useState(null);
  const navigate = useNavigate();
  const isSignUp = mode === 'signup';

  useEffect(() => {
    document.documentElement.classList.add('no-overscroll');
    return () => document.documentElement.classList.remove('no-overscroll');
  }, []);

  useEffect(() => {
    const ref = isSignUp ? signupRef : signinRef;
    if (ref.current) setHeight(ref.current.scrollHeight);
  }, [isSignUp, username, displayName, email, identifier]);


  // Resolve a login identifier to an email. Supports raw email or username lookup.
  const resolveEmail = async (val) => {
    const v = val.trim();
    if (!v) throw new Error('identifier-required');
    if (v.includes('@')) return v;
    const { data, error: qErr } = await supabase
      .from('profiles')
      .select('email')
      .eq('normalized_username', v.toLowerCase())
      .single();
    if (qErr || !data?.email) throw new Error('username-not-found');
    return data.email;
  };

  const handleSignUp = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);

    const name = username.trim();
    if (!name) { setError('Choose a username.'); setLoading(false); return; }
    if (!USERNAME_RE.test(name)) {
      setError('3 to 20 chars: letters, numbers, underscores.');
      setLoading(false);
      return;
    }
    if (!confirmedAge) { setError('You must be 18 or older to create an account.'); setLoading(false); return; }
    if (!acceptedPolicies) { setError('Please agree to the Terms and Privacy Policy to continue.'); setLoading(false); return; }

    try {
      const normalized = name.toLowerCase();

      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('normalized_username', normalized)
        .single();
      if (existing) throw new Error('username-taken');

      const { data: authData, error: signUpErr } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            display_name: displayName.trim() || name,
            username: name,
          }
        }
      });
      if (signUpErr) throw signUpErr;

      const uid = authData.user?.id;
      if (!uid) throw new Error('Signup failed: no user ID returned.');

      // Create profile row only when a session is immediately available.
      // When email confirmation is required, authData.session is null, so we
      // cannot insert without an auth token. In that case App.jsx's
      // ensureProfile runs automatically after the user confirms and signs in.
      if (authData.session) {
        const { error: profileErr } = await supabase.from('profiles').insert({
          id: uid,
          email: email.trim(),
          display_name: displayName.trim() || name,
          username: name,
          normalized_username: normalized,
          is_anonymous: false,
          following_ids: [],
          follower_ids: [],
        });
        if (profileErr) throw profileErr;
      } else {
        // Email confirmation is on: there is no session yet and no redirect
        // happens, so say so instead of leaving the form sitting there.
        setNotice('Account created. Check your email for the confirmation link, then sign in.');
      }
    } catch (err) {
      setError(friendlyMsg(err));
    }
    setLoading(false);
  };

  const handleForgotPassword = async () => {
    const addr = forgotEmail.trim();
    if (!addr) { setError('Enter your email address.'); return; }
    setForgotLoading(true);
    setError('');
    setForgotStatus('');
    try {
      const { error: err } = await supabase.auth.resetPasswordForEmail(addr);
      if (err) throw err;
      setForgotStatus('Reset email sent. Check your inbox.');
    } catch (err) {
      setError(friendlyMsg(err));
    }
    setForgotLoading(false);
  };

  const handleSignIn = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);
    try {
      const mail = await resolveEmail(identifier);
      const { error: err } = await supabase.auth.signInWithPassword({ email: mail, password });
      if (err) throw err;
    } catch (err) {
      setError(friendlyMsg(err));
    }
    setLoading(false);
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      if (Capacitor.isNativePlatform()) {
        const { data, error: err } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: NATIVE_OAUTH_REDIRECT,
            skipBrowserRedirect: true,
          }
        });
        if (err) throw err;
        if (!data?.url) throw new Error('Sign in failed. Please try again.');

        let finished = false;
        let appUrlListener;
        let browserFinishedListener;
        let authStateSubscription;
        let browserFinishTimeout;

        const cleanup = async () => {
          if (browserFinishTimeout) {
            clearTimeout(browserFinishTimeout);
            browserFinishTimeout = null;
          }
          if (appUrlListener) await appUrlListener.remove();
          if (browserFinishedListener) await browserFinishedListener.remove();
          if (authStateSubscription) authStateSubscription.unsubscribe();
        };

        const completeNativeOAuth = async (source) => {
          if (finished) return;
          finished = true;
          setLoading(false);
          navigate('/journal', { replace: true });

          Browser.close()
            .then(() => {})
            .catch((closeErr) => {
              const closeMessage = closeErr?.message || closeErr?.errorMessage || String(closeErr);
              if ((closeMessage || '').includes('No active window to close')) {
                return;
              }
            });

          await cleanup();
        };

        const { data: authListenerData } = supabase.auth.onAuthStateChange(async (event) => {
          if (event !== 'SIGNED_IN') return;
          try {
            await completeNativeOAuth('SIGNED_IN listener');
          } catch {
            setLoading(false);
          }
        });
        authStateSubscription = authListenerData.subscription;

        appUrlListener = await CapacitorApp.addListener('appUrlOpen', async ({ url }) => {
          if (finished || !url?.startsWith(NATIVE_OAUTH_SCHEME)) return;
          try {
            const parsed = new URL(url);
            const code = parsed.searchParams.get('code');

            if (code) {
              const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
              if (exchangeError) throw exchangeError;
            } else {
              const hashParams = new URLSearchParams((parsed.hash || '').replace(/^#/, ''));
              const accessToken = hashParams.get('access_token');
              const refreshToken = hashParams.get('refresh_token');
              if (!accessToken || !refreshToken) {
                throw new Error('Missing auth session data from Google callback.');
              }
              const { error: setSessionError } = await supabase.auth.setSession({
                access_token: accessToken,
                refresh_token: refreshToken,
              });
              if (setSessionError) throw setSessionError;
            }

            await completeNativeOAuth('appUrlOpen callback');
          } catch (exchangeErr) {
            setError(friendlyMsg(exchangeErr));
            setLoading(false);
          } finally {
            if (!finished) {
              // Keep listeners alive briefly so a delayed SIGNED_IN event can still complete.
              browserFinishTimeout = setTimeout(() => {
                cleanup().catch(() => {});
              }, 12000);
            }
          }
        });

        browserFinishedListener = await Browser.addListener('browserFinished', async () => {
          // If the browser closes naturally, keep listeners active a little longer
          // because callback handoff can be delayed on iOS.
          if (finished) return;
          await wait(2000);
          if (finished) return;

          // Recover when appUrlOpen is delayed/missed: if session already exists, complete sign-in.
          try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
              await completeNativeOAuth('browserFinished session check');
              return;
            }
          } catch {
            // Ignore and fall through to timeout-based cleanup.
          }

          if (browserFinishTimeout) {
            clearTimeout(browserFinishTimeout);
          }
          browserFinishTimeout = setTimeout(async () => {
            if (finished) return;
            await cleanup();
            setLoading(false);
            setError('Google sign-in did not complete. Please check your internet connection and try again.');
          }, 9000);
        });

        await Browser.open({
          url: data.url,
          presentationStyle: 'fullscreen',
        });
        return;
      }

      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin }
      });
      if (err) throw err;
      // After redirect, onAuthStateChange fires and App.jsx provisions the profile if needed
    } catch (err) {
      setError(friendlyMsg(err));
      setLoading(false);
    }
  };

  const handleAppleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      const rawNonce = generateRawNonce();
      const hashedNonce = await sha256Hex(rawNonce);

      const result = await SignInWithApple.authorize({
        clientId: 'dev.nightlink',
        redirectURI: NATIVE_OAUTH_REDIRECT,
        scopes: 'email name',
        nonce: hashedNonce,
      });

      const identityToken = result?.response?.identityToken;
      if (!identityToken) throw new Error('Apple sign in failed. Please try again.');

      const { error: err } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: identityToken,
        nonce: rawNonce,
      });
      if (err) throw err;
      // onAuthStateChange in App.jsx fires → ensureProfile provisions the row
    } catch (err) {
      // User cancelled the sheet, so don't show an error
      const msg = err?.message || '';
      if (!msg.includes('cancelled') && !msg.includes('canceled') && !msg.includes('dismiss')) {
        setError(friendlyMsg(err));
      }
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-container">
        <h1 className="auth-title">
          <span className="auth-title-icon" aria-hidden="true">
            <img src="/favicon.svg" alt="" />
          </span>
          <span className="auth-title-text">Nightlink</span>
        </h1>
        <p className="auth-subtitle">Your dreams, your story</p>

        {mode !== 'forgot' && (
          <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
            <button
              role="tab"
              aria-selected={!isSignUp}
              className={!isSignUp ? 'active' : ''}
              onClick={() => { setMode('signin'); setError(''); setNotice(''); setShowPassword(false); }}
            >
              Sign In
            </button>
            <button
              role="tab"
              aria-selected={isSignUp}
              className={isSignUp ? 'active' : ''}
              onClick={() => { setMode('signup'); setError(''); setNotice(''); setShowPassword(false); }}
            >
              Sign Up
            </button>
          </div>
        )}

        {mode === 'forgot' ? (
          <form className="auth-form" onSubmit={(e) => { e.preventDefault(); handleForgotPassword(); }}>
            <p className="auth-forgot-desc">
              Enter your email and we&apos;ll send you a password reset link.
            </p>
            <input
              type="email"
              placeholder="Email address"
              aria-label="Email address"
              value={forgotEmail}
              onChange={(e) => setForgotEmail(e.target.value)}
              className="auth-input"
              autoComplete="email"
              enterKeyHint="send"
            />
            {error && <p className="auth-error">{error}</p>}
            {forgotStatus && <p className="auth-success">{forgotStatus}</p>}
            <button
              type="submit"
              disabled={forgotLoading}
              className="auth-submit"
            >
              {forgotLoading ? 'Sending…' : 'Send Reset Email'}
            </button>
            <button
              type="button"
              className="auth-back-link"
              onClick={() => { setMode('signin'); setError(''); setForgotStatus(''); setForgotEmail(''); }}
            >
              ← Back to Sign In
            </button>
          </form>
        ) : (
          <form onSubmit={isSignUp ? handleSignUp : handleSignIn} className="auth-form">
            <div className="auth-field-switch" style={height ? { height: `${height}px` } : undefined}>
              <div
                className={`auth-field-group signup-group ${isSignUp ? 'is-active' : ''}`}
                aria-hidden={!isSignUp}
                ref={signupRef}
              >
                <input
                  type="text"
                  placeholder="Username"
                  aria-label="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required={isSignUp}
                  className="auth-input"
                  autoComplete="username"
                  tabIndex={isSignUp ? 0 : -1}
                />
                <input
                  type="text"
                  placeholder="Display Name (optional)"
                  aria-label="Display name (optional)"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="auth-input"
                  autoComplete="nickname"
                  tabIndex={isSignUp ? 0 : -1}
                />
                <input
                  type="email"
                  placeholder="Email"
                  aria-label="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required={isSignUp}
                  className="auth-input"
                  autoComplete="email"
                  tabIndex={isSignUp ? 0 : -1}
                />
              </div>

              <div
                className={`auth-field-group signin-group ${!isSignUp ? 'is-active' : ''}`}
                aria-hidden={isSignUp}
                ref={signinRef}
              >
                <input
                  type="text"
                  placeholder="Email or Username"
                  aria-label="Email or username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required={!isSignUp}
                  className="auth-input"
                  autoComplete="username"
                  tabIndex={!isSignUp ? 0 : -1}
                />
              </div>
            </div>

            <div className="auth-password-wrap">
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Password"
                aria-label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="auth-input"
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
              />
              <button
                type="button"
                className="auth-password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            {isSignUp && (
              <p className="auth-password-hint">At least 8 characters</p>
            )}
            {isSignUp && (
              <label className="auth-policy-check">
                <input
                  type="checkbox"
                  checked={confirmedAge}
                  onChange={(e) => setConfirmedAge(e.target.checked)}
                />
                <span>I confirm I am 18 years of age or older.</span>
              </label>
            )}
            {isSignUp && (
              <label className="auth-policy-check">
                <input
                  type="checkbox"
                  checked={acceptedPolicies}
                  onChange={(e) => setAcceptedPolicies(e.target.checked)}
                />
                <span>
                  I agree to the <Link to="/terms">Terms of Use</Link> and <Link to="/privacy">Privacy Policy</Link>, and understand there is no tolerance for abusive or objectionable content.
                </span>
              </label>
            )}
            {!isSignUp && (
              <button
                type="button"
                className="auth-forgot-link"
                onClick={() => { setMode('forgot'); setError(''); setForgotEmail(identifier.includes('@') ? identifier : ''); }}
              >
                Forgot your password?
              </button>
            )}

            {error && <p className="auth-error">{error}</p>}
            {notice && <p className="auth-success">{notice}</p>}

            <button type="submit" disabled={loading} className="auth-submit">
              {loading ? 'Working…' : isSignUp ? 'Create Account' : 'Sign In'}
            </button>

            <div className="auth-divider">
              <span>or</span>
            </div>

            <button type="button" onClick={handleGoogleSignIn} disabled={loading} className="auth-google-btn">
              <svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
                <g transform="matrix(1, 0, 0, 1, 27.009001, -39.238998)">
                  <path fill="#4285F4" d="M -3.264 51.509 C -3.264 50.719 -3.334 49.969 -3.454 49.239 L -14.754 49.239 L -14.754 53.749 L -8.284 53.749 C -8.574 55.229 -9.424 56.479 -10.684 57.329 L -10.684 60.329 L -6.824 60.329 C -4.564 58.239 -3.264 55.159 -3.264 51.509 Z" />
                  <path fill="#34A853" d="M -14.754 63.239 C -11.514 63.239 -8.804 62.159 -6.824 60.329 L -10.684 57.329 C -11.764 58.049 -13.134 58.489 -14.754 58.489 C -17.884 58.489 -20.534 56.379 -21.484 53.529 L -25.464 53.529 L -25.464 56.619 C -23.494 60.539 -19.444 63.239 -14.754 63.239 Z" />
                  <path fill="#FBBC05" d="M -21.484 53.529 C -21.734 52.809 -21.864 52.039 -21.864 51.239 C -21.864 50.439 -21.724 49.669 -21.484 48.949 L -21.484 45.859 L -25.464 45.859 C -26.284 47.479 -26.754 49.299 -26.754 51.239 C -26.754 53.179 -26.284 54.999 -25.464 56.619 L -21.484 53.529 Z" />
                  <path fill="#EA4335" d="M -14.754 43.989 C -12.984 43.989 -11.404 44.599 -10.154 45.789 L -6.734 42.369 C -8.804 40.429 -11.514 39.239 -14.754 39.239 C -19.444 39.239 -23.494 41.939 -25.464 45.859 L -21.484 48.949 C -20.534 46.099 -17.884 43.989 -14.754 43.989 Z" />
                </g>
              </svg>
              Continue with Google
            </button>

            {IS_IOS_NATIVE && (
              <button type="button" onClick={handleAppleSignIn} disabled={loading} className="auth-apple-btn">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 814 1000" width="17" height="17" fill="currentColor" aria-hidden="true">
                  <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-57.8-155.5-127.4C46 790.7 0 663 0 541.8c0-207.5 135.4-317.3 269-317.3 70.1 0 128.4 46.4 172.5 46.4 39.6 0 113.6-49.8 192.5-49.8zm-154.4-91.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z" />
                </svg>
                Continue with Apple
              </button>
            )}
          </form>
        )}

        <div className="auth-privacy-message">
          <p>🔒 Your dreams stay private and secure. No data collection for AI training.</p>
        </div>

        <p className="auth-legal-links">
          <Link to="/terms">Terms of Use</Link>
          <span aria-hidden="true">•</span>
          <Link to="/privacy">Privacy Policy</Link>
        </p>
      </div>
    </div>
  );
}
