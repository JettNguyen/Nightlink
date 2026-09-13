import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../supabase';
import { mapProfile } from '../utils/mappers';
import { SettingsSkeleton } from '../components/SkeletonLoader';
import { appUserPropType } from '../propTypes';
import { Capacitor } from '@capacitor/core';
import { areNotificationsSupported, disableNotifications, getNotificationPermission, getNotificationPermissionStatus, requestNotificationPermission } from '../utils/notificationHelpers';
import { triggerLightHaptic, triggerMediumHaptic, triggerSelectionHaptic, triggerSuccessHaptic, triggerErrorHaptic } from '../utils/haptics';
import {
  IS_RC_SUPPORTED,
  CREDITS_OFFERING_ID,
  PAYWALL_RESULT,
  getCustomerInfo,
  getOfferings,
  purchasePackage,
  restorePurchases as rcRestorePurchases,
  presentPaywallIfNeeded,
  presentCustomerCenter,
  isProFromCustomerInfo,
  syncCustomerInfoToSupabase,
  addCreditsToSupabase,
} from '../utils/purchases';
import Toast from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { useRcCustomerInfo } from '../contexts/SubscriptionContext';
import './Settings.css';

const DEFAULT_SETTINGS = {
  aiPromptPreset: 'balanced',
  aiPromptCustom: '',
  notificationsEnabled: false,
  notifyDreamReminders: true,
  reminderHour: 9,
  notifyFeedUpdates: true,
  notifyActivityAlerts: true
};

const FREE_ALLOWED_PRESETS = new Set(['balanced', 'coach', 'therapist']);
const STRIPE_ENDPOINT = import.meta.env.VITE_STRIPE_ENDPOINT || '/api/stripe';
const DEFAULT_API_ORIGIN = 'https://www.nightlink.dev';

const resolveAccountEndpoint = () => {
  const configuredEndpoint = (import.meta.env.VITE_ACCOUNT_ENDPOINT || '').trim();
  if (configuredEndpoint) return configuredEndpoint;

  const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || '').trim();
  if (configuredApiBase) return `${configuredApiBase.replace(/\/$/, '')}/api/account`;

  if (Capacitor.isNativePlatform()) {
    return `${DEFAULT_API_ORIGIN}/api/account`;
  }

  return '/api/account';
};

const ACCOUNT_ENDPOINT = resolveAccountEndpoint();
const PREMIUM_PRICE_ID = import.meta.env.VITE_STRIPE_PREMIUM_PRICE_ID || '';
const CREDIT_PRICE_ID = import.meta.env.VITE_STRIPE_CREDIT_PRICE_ID || '';
const PREMIUM_PAYMENT_LINK = import.meta.env.VITE_STRIPE_PREMIUM_LINK || '';
const CREDIT_PAYMENT_LINK = import.meta.env.VITE_STRIPE_CREDIT_LINK || '';

const PROMPT_PRESETS = [
  { id: 'balanced', title: 'Balanced Guide', description: 'Mix meaningful symbols with grounded actions you can take today.' },
  { id: 'coach', title: 'Sleep Coach', description: 'Focus on rest quality, stress signals, and calming bedtime rituals.' },
  { id: 'therapist', title: 'Comfort AI', description: "Gentle reassurance for nightmares with grounded reminders that you're safe." },
  { id: 'scientist', title: 'Brain Scientist', description: 'Neuroscience-backed explanations of REM sleep and memory processing.' },
  { id: 'mystical', title: 'Mystic Oracle', description: 'Poetic interpretations with archetypal wisdom and spiritual vibes.' },
  { id: 'astrology', title: 'Astrology Guide', description: 'Celestial wisdom connecting your dream to lunar cycles and planetary transits.' },
  { id: 'creative', title: 'Story Weaver', description: 'Turn your dream into a narrative seed for writing or worldbuilding.' },
  { id: 'director', title: 'Movie Director', description: 'One paragraph film treatment of your dream. Bold, cinematic, occasionally chaotic.' },
  { id: 'comedian', title: 'Dream Comedian', description: 'Light-hearted, humorous takes on the absurdity of your subconscious.' },
  { id: 'custom', title: 'Custom', description: 'Write your own instructions for exactly how insights should feel.' }
];

const PROMPT_ID_ALIASES = { investigator: 'director' };
const normalizePresetId = (id) => PROMPT_ID_ALIASES[id] || id || 'balanced';

const isPresetLocked = (tier, presetId) => (
  tier !== 'premium' && !FREE_ALLOWED_PRESETS.has(normalizePresetId(presetId))
);

const BLOCKED_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier)/i,
  /disregard\s+(all\s+)?(previous|prior|instructions|rules)/i,
  /forget\s+(everything|all|your|the)/i,
  /new\s+instructions?:/i,
  /system\s*:/i,
  /\bact\s+as\s+(a\s+)?(terminal|admin|root)/i,
  /execute\s+(code|command|script)/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /pretend\s+you('re|\s+are)\s+(not|no\s+longer)/i,
  /you\s+are\s+now\s+(?!a\s+dream)/i,
  /jailbreak/i,
  /bypass\s+(your|the|all)/i,
  /override\s+(your|the|all)/i,
  /(write|generate|make)\s+(longer|more|extended)/i,
  /(longer|extended|detailed)\s+(output|response|paragraph)/i,
  /no\s+(limit|restriction|constraint)/i,
  /(remove|lift|disable)\s+(the\s+)?(limit|restriction|constraint)/i,
  /as\s+many\s+(sentences|words|paragraphs)/i,
  /(unlimited|infinite|maximum)\s+(length|output)/i,
  /\d+\s+(sentences|paragraphs|words)\s+(or\s+more|minimum)/i
];

const MAX_PROMPT_LENGTH = 400;

const stripControlChars = (value) => (
  Array.from(value || '')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return !(code <= 31 || (code >= 127 && code <= 159));
    })
    .join('')
);

const sanitizePrompt = (raw) => {
  if (!raw || typeof raw !== 'string') return '';
  let clean = raw
    .split('\n').join(' ');
  clean = stripControlChars(clean)
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PROMPT_LENGTH);
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(clean)) return '';
  }
  return clean;
};

const isPromptSafe = (text) => {
  if (!text || typeof text !== 'string') return true;
  return !BLOCKED_PATTERNS.some((p) => p.test(text));
};

function Toggle({ checked, onChange, id, disabled }) {
  return (
    <label className={`toggle-switch${disabled ? ' is-disabled' : ''}`} htmlFor={id}>
      <input type="checkbox" id={id} checked={checked} onChange={onChange} disabled={disabled} />
      <span className="toggle-track" />
    </label>
  );
}

Toggle.propTypes = {
  checked: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
  id: PropTypes.string.isRequired,
  disabled: PropTypes.bool
};

Toggle.defaultProps = {
  disabled: false
};

export default function Settings({ user }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [notificationsSupported, setNotificationsSupported] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState(() => getNotificationPermission());
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState('');
  const [hasPasswordLogin, setHasPasswordLogin] = useState(() => (
    user?.providerData?.some((p) => p.providerId === 'email') ?? false
  ));
  const [passwordForm, setPasswordForm] = useState({ newPassword: '', confirmPassword: '' });
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordStatus, setPasswordStatus] = useState('');
  const [promptError, setPromptError] = useState('');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [billingStatus, setBillingStatus] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const { rcCustomerInfo, setRcCustomerInfo } = useRcCustomerInfo();
  const savedRef = useRef(JSON.stringify(DEFAULT_SETTINGS));
  const uid = user?.uid || null;
  const isNativeIOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

  // Merge Supabase tier with live RC state, since RC is authoritative on iOS.
  // Using the most-permissive value means UI unlocks immediately after a
  // purchase without waiting for the Supabase real-time event to arrive.
  const supabaseTier = profile?.subscription?.tier === 'premium' ? 'premium' : 'free';
  const rcIsPro = isProFromCustomerInfo(rcCustomerInfo);
  const tier = supabaseTier === 'premium' || (IS_RC_SUPPORTED && rcIsPro) ? 'premium' : 'free';
  const creditBalance = Number(profile?.aiUsage?.creditBalance || 0);
  const currentMonthYear = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const monthlyCount = Number(
    profile?.aiUsage?.monthYear === currentMonthYear
      ? (profile?.aiUsage?.monthlyCount || 0)
      : 0
  );
  const freeRemaining = Math.max(0, 1 - monthlyCount);
  const proRemaining = Math.max(0, 30 - monthlyCount);

  useEffect(() => {
    if (!uid) {
      setLoading(false);
      return;
    }

    const fetchProfile = async () => {
      const { data } = await supabase.from('profiles').select('*').eq('id', uid).single();
      setLoading(false);
      if (!data) {
        setProfile(null);
        savedRef.current = JSON.stringify(DEFAULT_SETTINGS);
        setSettings(DEFAULT_SETTINGS);
        return;
      }
      const p = mapProfile(data);
      setProfile(p);
      const incoming = p.settings || {};
      const incomingTier = p?.subscription?.tier === 'premium' ? 'premium' : 'free';
      let normalizedPreset = normalizePresetId(incoming.aiPromptPreset || 'balanced');
      if (isPresetLocked(incomingTier, normalizedPreset)) {
        normalizedPreset = 'balanced';
      }
      const merged = {
        ...DEFAULT_SETTINGS,
        ...incoming,
        aiPromptPreset: normalizedPreset,
        aiPromptCustom: incoming.aiPromptCustom ?? ''
      };
      if (incoming.notifyReactions !== undefined && incoming.notifyActivityAlerts === undefined) {
        merged.notifyActivityAlerts = incoming.notifyReactions;
      }
      savedRef.current = JSON.stringify(merged);
      setSettings(merged);
    };

    fetchProfile();

    const channel = supabase
      .channel(`settings:${uid}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${uid}` },
        (payload) => {
          const p = mapProfile(payload.new);
          setProfile(p);
          const incoming = p.settings || {};
          const incomingTier = p?.subscription?.tier === 'premium' ? 'premium' : 'free';
          let normalizedPreset = normalizePresetId(incoming.aiPromptPreset || 'balanced');
          if (isPresetLocked(incomingTier, normalizedPreset)) {
            normalizedPreset = 'balanced';
          }
          const merged = {
            ...DEFAULT_SETTINGS,
            ...incoming,
            aiPromptPreset: normalizedPreset,
            aiPromptCustom: incoming.aiPromptCustom ?? ''
          };
          // Only update settings from real-time if user hasn't made local changes
          // This prevents unsaved changes from being overridden by real-time updates
          const currentSettingsStr = JSON.stringify(settings);
          if (currentSettingsStr === savedRef.current) {
            savedRef.current = JSON.stringify(merged);
            setSettings(merged);
          }
        })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [uid]);


  useEffect(() => {
    if (!uid || !user?.getIdToken) return;

    const syncEffectiveTier = async () => {
      try {
        const idToken = await user.getIdToken();
        if (!idToken) return;
        const response = await fetch(ACCOUNT_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`
          },
          body: JSON.stringify({
            action: 'sync_subscription_tier',
            uid
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.success) return;
        if (!payload?.tier) return;
        setProfile((prev) => {
          if (!prev) return prev;
          if (prev?.subscription?.tier === payload.tier) return prev;
          return {
            ...prev,
            subscription: {
              ...(prev.subscription || {}),
              tier: payload.tier
            }
          };
        });
      } catch (error) {
        console.error('Tier sync failed', error);
      }
    };

    syncEffectiveTier();
  }, [uid, user]);

  useEffect(() => {
    setNotificationsSupported(areNotificationsSupported());
    getNotificationPermissionStatus()
      .then((permission) => setNotificationPermission(permission))
      .catch(() => setNotificationPermission(getNotificationPermission()));
  }, []);

  useEffect(() => {
    const hasEmail = user?.providerData?.some((p) => p.providerId === 'email') ?? false;
    const persistedPasswordLogin = Boolean(profile?.settings?.hasPasswordLogin);
    setHasPasswordLogin(hasEmail || persistedPasswordLogin);
  }, [user?.providerData?.length, user?.uid, profile?.settings?.hasPasswordLogin]);

  useEffect(() => {
    // Check Supabase identities directly in case password changes don't trigger parent update
    if (!uid) return;
    const checkSupabaseIdentities = async () => {
      const { data: { user: supabaseUser } } = await supabase.auth.getUser();
      if (supabaseUser?.identities?.some((i) => i.provider === 'email')) {
        setHasPasswordLogin(true);
      }
    };
    checkSupabaseIdentities().catch(console.error);
  }, [uid]);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(''), 3000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    if (!notificationMessage) return;
    const t = setTimeout(() => setNotificationMessage(''), 4000);
    return () => clearTimeout(t);
  }, [notificationMessage]);

  useEffect(() => {
    if (!passwordStatus) return;
    const t = setTimeout(() => setPasswordStatus(''), 4000);
    return () => clearTimeout(t);
  }, [passwordStatus]);

  useEffect(() => {
    if (!billingStatus) return;
    const t = setTimeout(() => setBillingStatus(''), 5000);
    return () => clearTimeout(t);
  }, [billingStatus]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get('payment');
    if (payment === 'success') {
      setBillingStatus('Payment complete. Your account updates within a few seconds.');
      if (uid) {
        const fetchFresh = async () => {
          try {
            const { data } = await supabase.from('profiles').select('*').eq('id', uid).single();
            if (data) {
              const p = mapProfile(data);
              setProfile(p);
            }
          } catch (err) {
            console.error('Failed to refresh profile after payment:', err);
          }
        };
        // Small delay to ensure server-side processing is complete
        const timeout = setTimeout(fetchFresh, 500);
        return () => clearTimeout(timeout);
      }
    } else if (payment === 'cancelled') {
      setBillingStatus('Checkout cancelled. No charge was made.');
    }
  }, [uid]);

  // On iOS, force a WebKit repaint once the profile finishes loading.
  // The transition from loading-spinner → full content causes a large DOM
  // swap that can leave stale GPU tiles (visible as a blank box) until the
  // user scrolls. Toggling opacity triggers immediate rasterization without
  // any visible change or scroll movement.
  useEffect(() => {
    if (!isNativeIOS || loading) return;
    const page = document.querySelector('.settings-page');
    if (!page) return;
    page.style.opacity = '0.9999';
    const raf = requestAnimationFrame(() => {
      page.style.opacity = '';
    });
    return () => {
      cancelAnimationFrame(raf);
      page.style.opacity = '';
    };
  }, [isNativeIOS, loading]);


  const hasChanges = useMemo(() => {
    if (loading) return false;
    try {
      // Sort keys before comparing so insertion-order differences don't cause false positives
      const normalize = (obj) => JSON.stringify(obj, Object.keys(obj).sort());
      return normalize(settings) !== normalize(JSON.parse(savedRef.current));
    } catch {
      return JSON.stringify(settings) !== savedRef.current;
    }
  }, [settings, loading]);
  const update = useCallback((key, value) => setSettings((prev) => ({ ...prev, [key]: value })), []);
  const toggle = (key) => {
    void triggerSelectionHaptic();
    update(key, !settings[key]);
  };

  const selectPreset = (id) => {
    const normalized = normalizePresetId(id);
    if (isPresetLocked(tier, normalized)) {
      setBillingStatus('That style is part of Pro. Upgrade to unlock it.');
      return;
    }
    if (settings.aiPromptPreset !== normalized) {
      void triggerSelectionHaptic();
    }
    update('aiPromptPreset', normalized);
  };

  const handleCustomPromptChange = (value) => {
    const trimmed = value.slice(0, MAX_PROMPT_LENGTH);
    update('aiPromptCustom', trimmed);
    setPromptError(!isPromptSafe(trimmed) ? 'This prompt contains blocked phrases. Please revise.' : '');
  };

  const handlePasswordField = (key, value) => {
    setPasswordForm((prev) => ({ ...prev, [key]: value }));
    setPasswordError('');
  };

  const handleNotificationsToggle = useCallback(async () => {
    if (!uid || notificationBusy) return;
    if (!notificationsSupported) {
      setNotificationMessage('Push notifications are not supported in this browser.');
      return;
    }
    setNotificationBusy(true);
    setNotificationMessage('');
    try {
      if (!settings.notificationsEnabled) {
        const token = await requestNotificationPermission(uid);
        const permission = await getNotificationPermissionStatus();
        setNotificationPermission(permission);
        if (token) {
          update('notificationsEnabled', true);
          setNotificationMessage('Notifications enabled for this device.');
        } else if (permission === 'denied') {
          setNotificationMessage('Permission blocked. Enable notifications in your browser settings to continue.');
        } else {
          setNotificationMessage('Could not enable notifications. Please try again.');
        }
      } else {
        await disableNotifications(uid);
        update('notificationsEnabled', false);
        setNotificationPermission(await getNotificationPermissionStatus());
        setNotificationMessage('Notifications disabled for this device.');
      }
    } catch (error) {
      console.error('Notification toggle failed', error);
      setNotificationMessage('Something went wrong while updating notifications.');
    } finally {
      setNotificationBusy(false);
    }
  }, [uid, notificationBusy, notificationsSupported, settings.notificationsEnabled, update]);

  const passwordRequirementsMet = useMemo(() => {
    const next = passwordForm.newPassword.trim();
    return next.length >= 8 && next === passwordForm.confirmPassword.trim();
  }, [passwordForm]);

  const handlePasswordSave = useCallback(async () => {
    setPasswordBusy(true);
    setPasswordError('');
    setPasswordStatus('');
    try {
      if (hasPasswordLogin) {
        // Send password reset email
        const { error } = await supabase.auth.resetPasswordForEmail(user?.email);
        if (error) throw error;
        setPasswordStatus('Password reset link sent to your email. Check your inbox.');
      } else {
        // Set new password
        const next = passwordForm.newPassword.trim();
        const confirm = passwordForm.confirmPassword.trim();
        if (next.length < 8) {
          setPasswordError('Use at least 8 characters for your password.');
          return;
        }
        if (next !== confirm) {
          setPasswordError('Passwords do not match.');
          return;
        }
        const { error } = await supabase.auth.updateUser({ password: next });
        if (error) throw error;
        setHasPasswordLogin(true);
        // Persist this for refreshes, especially for OAuth users who add a password later.
        const persistedSettings = { ...(profile?.settings || {}), hasPasswordLogin: true };
        const { error: profileError } = await supabase
          .from('profiles')
          .update({ settings: persistedSettings })
          .eq('id', uid);
        if (profileError) {
          console.error('Failed to persist hasPasswordLogin flag', profileError);
        } else {
          setProfile((prev) => (prev ? { ...prev, settings: persistedSettings } : prev));
        }
        await supabase.auth.refreshSession();
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user?.identities?.some((i) => i.provider === 'email')) {
          setHasPasswordLogin(true);
        }
        setPasswordStatus('Password saved. You can now sign in with your email or username again.');
        setPasswordForm({ newPassword: '', confirmPassword: '' });
      }
    } catch (error) {
      setPasswordError(error.message || 'Failed to process password request.');
    } finally {
      setPasswordBusy(false);
    }
  }, [passwordForm, hasPasswordLogin, user?.email, profile?.settings, uid]);

  const notificationPermissionLabel = useMemo(() => {
    if (notificationPermission === 'granted') return 'Permission granted';
    if (notificationPermission === 'denied') return 'Permission blocked';
    return 'Permission pending';
  }, [notificationPermission]);

  const canSave = useMemo(() => {
    if (!hasChanges) return false;
    if (isPresetLocked(tier, settings.aiPromptPreset)) return false;
    if (settings.aiPromptPreset === 'custom' && !isPromptSafe(settings.aiPromptCustom)) return false;
    return true;
  }, [hasChanges, settings.aiPromptPreset, settings.aiPromptCustom, tier]);

  const handleSave = async () => {
    if (!uid || saving || !canSave) return;
    setSaving(true);
    setStatus('');

    const presetId = normalizePresetId(settings.aiPromptPreset);
    const lockedForTier = isPresetLocked(tier, presetId);
    const effectivePreset = lockedForTier ? 'balanced' : presetId;
    const sanitizedCustom = sanitizePrompt(settings.aiPromptCustom);
    const savedSettings = {
      ...settings,
      aiPromptPreset: effectivePreset,
      aiPromptCustom: sanitizedCustom
    };

    try {
      const { error } = await supabase.from('profiles').update({ settings: savedSettings }).eq('id', uid);
      if (error) throw error;
      savedRef.current = JSON.stringify(savedSettings);
      setStatus('saved');
      void triggerSuccessHaptic();
    } catch (err) {
      console.error('Settings save failed', err);
      void triggerErrorHaptic();
      setStatus('error');
    } finally {
      setSaving(false);
    }
  };

  // Sits next to "You have unsaved changes", so it discards those edits rather
  // than wiping every setting back to the app defaults.
  const handleReset = () => {
    try {
      setSettings(JSON.parse(savedRef.current));
    } catch {
      setSettings(DEFAULT_SETTINGS);
    }
    setPromptError('');
  };

  const handleStartCheckout = async (mode, priceId, paymentLink) => {
    if (!uid || checkoutBusy) return;
    setCheckoutBusy(true);
    setBillingStatus('');
    
    try {
      if (paymentLink) {
        window.location.assign(paymentLink);
        return;
      }

      if (!priceId) {
        setBillingStatus('Billing is not configured yet. Add Stripe price IDs or payment links in your environment first.');
        return;
      }

      const idToken = await user?.getIdToken?.();
      if (!idToken) {
        setBillingStatus('Please sign in again and retry checkout.');
        return;
      }

      const response = await fetch(STRIPE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify({
          action: 'create_checkout',
          uid,
          priceId,
          mode,
          successUrl: `${window.location.origin}/settings?payment=success`,
          cancelUrl: `${window.location.origin}/settings?payment=cancelled`
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.url) {
        throw new Error(payload?.error || 'Unable to start checkout.');
      }
      window.location.assign(payload.url);
    } catch (error) {
      setBillingStatus(error.message || 'Unable to start checkout.');
    } finally {
      setCheckoutBusy(false);
    }
  };

  const handlePresentPaywall = async () => {
    if (!uid || checkoutBusy) return;
    setCheckoutBusy(true);
    setBillingStatus('');
    try {
      const { result } = await presentPaywallIfNeeded();
      if (result === PAYWALL_RESULT.PURCHASED || result === PAYWALL_RESULT.RESTORED) {
        const info = await getCustomerInfo();
        setRcCustomerInfo(info);
        
        // Optimistically update local profile state immediately for instant UI feedback
        const isPro = isProFromCustomerInfo(info);
        setProfile((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            subscription: {
              ...(prev.subscription || {}),
              tier: isPro ? 'premium' : 'free',
              provider: 'revenuecat',
              updatedAt: new Date().toISOString(),
            },
          };
        });
        
        await syncCustomerInfoToSupabase(uid, info);

        setBillingStatus(
          result === PAYWALL_RESULT.RESTORED
            ? 'Subscription restored! Welcome back to Pro.'
            : 'Welcome to Pro! All styles and full quota are now unlocked.',
        );
      }
    } catch (err) {
      const msg = err?.message || '';
      if (!msg.toLowerCase().includes('cancel') && !msg.toLowerCase().includes('dismiss')) {
        setBillingStatus(msg || 'Purchase failed. Please try again.');
      }
    } finally {
      setCheckoutBusy(false);
    }
  };

  const handleBuyCredits = async () => {
    if (!uid || checkoutBusy) return;
    setCheckoutBusy(true);
    setBillingStatus('');
    try {
      const offerings = await getOfferings();
      const creditsOffering = offerings.all?.[CREDITS_OFFERING_ID];
      if (!creditsOffering?.availablePackages?.length) {
        setBillingStatus('Credits pack is not available right now. Try again later.');
        return;
      }
      const creditPackage = creditsOffering.availablePackages[0];
      const customerInfo = await purchasePackage(creditPackage);
      
      // Optimistically update credit balance immediately for instant feedback
      const CREDITS_PER_PACK = 10;
      setProfile((prev) => {
        if (!prev) return prev;
        const currentCredits = Number(prev?.aiUsage?.creditBalance || 0);
        return {
          ...prev,
          aiUsage: {
            ...(prev.aiUsage || {}),
            creditBalance: currentCredits + CREDITS_PER_PACK,
          },
        };
      });
      
      await addCreditsToSupabase(uid);
      await syncCustomerInfoToSupabase(uid, customerInfo);
      setRcCustomerInfo(customerInfo);
      
      setBillingStatus('10 AI credits added to your account!');
    } catch (err) {
      const msg = err?.message || '';
      if (!msg.toLowerCase().includes('cancel') && !msg.toLowerCase().includes('dismiss')) {
        setBillingStatus(msg || 'Purchase failed. Please try again.');
      }
    } finally {
      setCheckoutBusy(false);
    }
  };

  const handleRestorePurchases = async () => {
    if (!uid || checkoutBusy) return;
    setCheckoutBusy(true);
    setBillingStatus('');
    try {
      const customerInfo = await rcRestorePurchases();
      setRcCustomerInfo(customerInfo);
      await syncCustomerInfoToSupabase(uid, customerInfo);
      const nowPro = isProFromCustomerInfo(customerInfo);
      setBillingStatus(
        nowPro
          ? 'Pro subscription restored!'
          : 'No previous purchases found for this Apple ID.',
      );
    } catch (err) {
      setBillingStatus(err?.message || 'Restore failed. Please try again.');
    } finally {
      setCheckoutBusy(false);
    }
  };

  const handleManageSubscription = async () => {
    if (checkoutBusy) return;
    try {
      await presentCustomerCenter();
      // Refresh after the sheet closes in case user cancelled or got a refund
      const info = await getCustomerInfo();
      setRcCustomerInfo(info);
      
      // Optimistically update local profile state
      const isPro = isProFromCustomerInfo(info);
      setProfile((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          subscription: {
            ...(prev.subscription || {}),
            tier: isPro ? 'premium' : 'free',
            provider: 'revenuecat',
            updatedAt: new Date().toISOString(),
          },
        };
      });
      
      await syncCustomerInfoToSupabase(uid, info);
    } catch (err) {
      console.error('Customer center error:', err?.message || err);
    }
  };

  const handleDeleteAccount = () => {
    if (!uid || deletingAccount) return;
    setDeleteInput('');
    setDeleteConfirmOpen(true);
  };

  const executeDeleteAccount = async () => {
    setDeleteConfirmOpen(false);
    if (deleteInput !== 'DELETE') {
      setToast('Account deletion cancelled.');
      return;
    }

    setDeletingAccount(true);
    setBillingStatus('');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const idToken = sessionData?.session?.access_token;
      if (!idToken) {
        throw new Error('Please sign in again and retry.');
      }

      const response = await fetch(ACCOUNT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify({
          action: 'delete_account',
          uid,
          confirmText: 'DELETE'
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'Could not delete account.');
      }

      await supabase.auth.signOut();
      window.location.assign('/login');
    } catch (error) {
      setBillingStatus(error.message || 'Could not delete account.');
      setDeletingAccount(false);
    }
  };

  if (!uid) {
    return (
      <div className="page-container settings-page">
        <div className="settings-section">
          <div className="settings-section-body" style={{ textAlign: 'center', padding: '2rem' }}>
            <h2>Sign in required</h2>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
              You need to be logged in to manage your settings.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container settings-page">
      {!isNativeIOS && (
        <button type="button" className="page-back-btn" onClick={() => navigate('/profile')}>
          Profile
        </button>
      )}

      <header className="settings-header">
        <h1>Settings</h1>
        <p>Customize your experience.</p>
      </header>
      {!loading && (
        <div className="save-bar">
          <p>{hasChanges ? 'You have unsaved changes' : 'All changes saved'}</p>
          <div className="btn-group">
            {status === 'saved' && <span className="settings-status success">Saved</span>}
            {status === 'error' && <span className="settings-status error">Failed</span>}
            <button type="button" className="ghost-btn" onClick={handleReset} disabled={saving || !hasChanges}>Discard</button>
            <button type="button" className={`primary-btn${saving ? ' is-loading' : ''}`} onClick={handleSave} disabled={!canSave || saving} style={saving ? { cursor: 'wait' } : undefined}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <SettingsSkeleton />
      ) : (
        <div className="settings-sections">
          <section className="settings-section">
            <div className="settings-section-head">
              <h2>Billing</h2>
              <p>Upgrade to Pro for all AI styles plus 30 AI analyses per monthly billing cycle, or buy extra credits anytime.</p>
            </div>

            {isNativeIOS ? (
              /* ── RevenueCat / App Store billing (iOS) ── */
              <div className="settings-section-body">
                <div className="notification-support">
                  <span className={`notification-chip${tier === 'premium' ? ' success' : ''}`}>
                    {IS_RC_SUPPORTED && !rcCustomerInfo ? 'Checking plan…' : `Plan: ${tier === 'premium' ? 'Pro' : 'Free'}`}
                  </span>
                  {tier === 'premium' ? (
                    <span className="notification-chip success">Analyses left: {proRemaining}</span>
                  ) : (
                    <span className="notification-chip">Free this month: {freeRemaining}</span>
                  )}
                  <span className="notification-chip">Paid credits: {creditBalance}</span>
                </div>

                <div className="action-buttons">
                  {tier !== 'premium' ? (
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={handlePresentPaywall}
                      disabled={checkoutBusy || IS_RC_SUPPORTED && !rcCustomerInfo}
                    >
                      {checkoutBusy ? 'Opening…' : 'Upgrade to Pro'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={handleManageSubscription}
                      disabled={checkoutBusy}
                    >
                      Manage Subscription
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={handleBuyCredits}
                    disabled={checkoutBusy || IS_RC_SUPPORTED && !rcCustomerInfo}
                  >
                    {checkoutBusy ? 'Opening…' : 'Buy 10 AI Credits'}
                  </button>
                </div>

                <button
                  type="button"
                  className="rc-restore-btn"
                  onClick={handleRestorePurchases}
                  disabled={checkoutBusy}
                >
                  Restore purchases
                </button>

                {billingStatus && <p className="notification-alert">{billingStatus}</p>}
              </div>
            ) : (
              /* ── Stripe billing (web) ── */
              <div className="settings-section-body">
                <div className="notification-support">
                  <span className={`notification-chip${tier === 'premium' ? ' success' : ''}`}>
                    Plan: {tier === 'premium' ? 'Pro' : 'Free'}
                  </span>
                  {tier === 'premium' ? (
                    <span className="notification-chip success">Pro credits this cycle left: {proRemaining}</span>
                  ) : (
                    <span className="notification-chip">Free this month left: {freeRemaining}</span>
                  )}
                  <span className="notification-chip">Paid credits: {creditBalance}</span>
                </div>
                <div className="action-buttons">
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => handleStartCheckout('subscription', PREMIUM_PRICE_ID, PREMIUM_PAYMENT_LINK)}
                    disabled={checkoutBusy || tier === 'premium'}
                  >
                    {tier === 'premium' ? 'Pro active' : (checkoutBusy ? 'Opening checkout...' : 'Subscribe to Pro')}
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => handleStartCheckout('payment', CREDIT_PRICE_ID, CREDIT_PAYMENT_LINK)}
                    disabled={checkoutBusy}
                  >
                    {checkoutBusy ? 'Opening checkout...' : 'Buy 10 AI credits'}
                  </button>
                </div>
                {billingStatus && <p className="notification-alert">{billingStatus}</p>}
              </div>
            )}
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <h2>AI insight style</h2>
              <p>Your dreams stay private. AI never trains on or collects your data. Upgrade to Pro to unlock all styles, custom instructions, and a persistent dream memory that deepens over time.</p>
            </div>
            <div className="settings-section-body">
              <div className="prompt-options">
                {PROMPT_PRESETS.map((preset) => {
                  const locked = isPresetLocked(tier, preset.id);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={`prompt-option${settings.aiPromptPreset === preset.id ? ' selected' : ''}${locked ? ' locked' : ''}`}
                      onClick={() => selectPreset(preset.id)}
                    >
                      <h3>
                        {preset.title}
                        {locked && <span className="preset-lock-pill">Pro</span>}
                      </h3>
                      <p>{preset.description}</p>
                    </button>
                  );
                })}
              </div>
              {settings.aiPromptPreset === 'custom' && tier === 'premium' && (
                <div className="custom-prompt-area">
                  <label htmlFor="customPrompt">Your custom instructions</label>
                  <textarea
                    id="customPrompt"
                    value={settings.aiPromptCustom}
                    onChange={(e) => handleCustomPromptChange(e.target.value)}
                    maxLength={MAX_PROMPT_LENGTH}
                    placeholder="E.g. Act like a Jungian analyst who references mythology and gives one concrete journaling prompt at the end."
                  />
                  {promptError && <p className="prompt-error">{promptError}</p>}
                  <div className="custom-prompt-footer">
                    {MAX_PROMPT_LENGTH - (settings.aiPromptCustom?.length || 0)} characters remaining
                  </div>
                </div>
              )}
              <div className={`prompt-preview-box${tier !== 'premium' ? ' memory-locked' : ''}`}>
                <p className="preview-label">Dream memory {tier !== 'premium' && <span className="preset-lock-pill">Pro</span>}</p>
                <p className="preview-text">
                  {tier === 'premium'
                    ? 'Every analysis updates a private memory file of your recurring symbols, figures, emotional patterns, and themes. AI reads this memory when analyzing new dreams, so its insights grow sharper the more you journal.'
                    : 'Upgrade to Pro to have AI maintain a private memory of your recurring symbols, figures, and patterns that deepens with every analysis you run.'}
                </p>
                {tier === 'premium' && (
                  <Link to="/insights" className="memory-patterns-link">
                    View your dream patterns →
                  </Link>
                )}
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <h2>Notifications</h2>
              <p>Stay in the loop with morning reminders, feed drops, and activity alerts.</p>
            </div>
            <div className="settings-section-body">
              {!isNativeIOS && (
                <div className="notification-support">
                  <span className={`notification-chip${notificationsSupported ? ' success' : ' warn'}`}>
                    {notificationsSupported ? 'Browser supports push' : 'Push not supported'}
                  </span>
                  <span className={`notification-chip${notificationPermission === 'granted' ? ' success' : notificationPermission === 'denied' ? ' warn' : ''}`}>
                    {notificationPermissionLabel}
                  </span>
                </div>
              )}
              {!notificationsSupported && (
                <p className="notification-hint">Push notifications require a modern browser with Service Worker support.</p>
              )}
              <div className="toggle-row">
                <div className="toggle-label"><strong>Push notifications</strong><span>Receive updates even when Nightlink is closed.</span></div>
                <Toggle id="notificationsEnabled" checked={settings.notificationsEnabled} onChange={handleNotificationsToggle} disabled={!notificationsSupported || notificationBusy} />
              </div>
              <div className="toggle-row">
                <div className="toggle-label"><strong>Dream reminders</strong><span>Morning nudges to capture your dream journal while it is fresh.</span></div>
                <Toggle id="notifyDreamReminders" checked={settings.notifyDreamReminders} onChange={() => toggle('notifyDreamReminders')} disabled={!settings.notificationsEnabled} />
              </div>
              {settings.notificationsEnabled && settings.notifyDreamReminders && (
                <div className="toggle-row">
                  <div className="toggle-label"><strong>Reminder time</strong><span>When should we nudge you to log your dream?</span></div>
                  <input
                    type="time"
                    className="settings-time-input"
                    aria-label="Dream reminder time"
                    value={`${String(settings.reminderHour ?? 9).padStart(2, '0')}:00`}
                    step={3600}
                    onChange={(e) => {
                      const hour = parseInt(e.target.value?.split(':')?.[0] ?? '9', 10);
                      if (!Number.isNaN(hour)) update('reminderHour', hour);
                    }}
                  />
                </div>
              )}
              <div className="toggle-row">
                <div className="toggle-label"><strong>New feed drops</strong><span>Alerts when people you follow share new dreams or journal entries.</span></div>
                <Toggle id="notifyFeedUpdates" checked={settings.notifyFeedUpdates} onChange={() => toggle('notifyFeedUpdates')} disabled={!settings.notificationsEnabled} />
              </div>
              <div className="toggle-row">
                <div className="toggle-label"><strong>Activity alerts</strong><span>Followers, comments, and reactions-AI insights are never pushed.</span></div>
                <Toggle id="notifyActivityAlerts" checked={settings.notifyActivityAlerts} onChange={() => toggle('notifyActivityAlerts')} disabled={!settings.notificationsEnabled} />
              </div>
              {notificationMessage && <p className="notification-alert">{notificationMessage}</p>}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <h2>Account access</h2>
              <p>{hasPasswordLogin ? 'Reset your password.' : 'Enable password login.'}</p>
            </div>
            <div className="settings-section-body">
              {hasPasswordLogin ? (
                <>
                  <p className="password-helper">Send a password reset link to your email.</p>
                  <button type="button" className="primary-btn password-btn" onClick={handlePasswordSave} disabled={passwordBusy}>
                    {passwordBusy ? 'Sending...' : 'Send reset password email'}
                  </button>
                  {passwordStatus && <p className="password-success">{passwordStatus}</p>}
                  {passwordError && <p className="password-error">{passwordError}</p>}
                </>
              ) : (
                <>
                  <p className="password-helper">Set a password so you can sign in with your email or username.</p>
                  <div className="password-fields">
                    <input type="password" placeholder="New password" value={passwordForm.newPassword} onChange={(e) => handlePasswordField('newPassword', e.target.value)} minLength={8} autoComplete="new-password" />
                    <input type="password" placeholder="Confirm new password" value={passwordForm.confirmPassword} onChange={(e) => handlePasswordField('confirmPassword', e.target.value)} minLength={8} autoComplete="new-password" />
                  </div>
                  <p className="password-hint">Use at least 8 characters.</p>
                  {passwordError && <p className="password-error">{passwordError}</p>}
                  {passwordStatus && <p className="password-success">{passwordStatus}</p>}
                  <button type="button" className="primary-btn password-btn" onClick={handlePasswordSave} disabled={!passwordRequirementsMet || passwordBusy}>
                    {passwordBusy ? 'Saving...' : 'Enable password login'}
                  </button>
                </>
              )}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <h2>Legal</h2>
              <p>Read our Terms of Use and Privacy Policy. By using Nightlink you agree to these terms. We have zero tolerance for objectionable or abusive content.</p>
            </div>
            <div className="settings-section-body">
              <div className="action-buttons">
                <button type="button" className="ghost-btn legal-link-btn" onClick={() => navigate('/terms')}>Terms of Use</button>
                <button type="button" className="ghost-btn legal-link-btn" onClick={() => navigate('/privacy')}>Privacy Policy</button>
              </div>
              <p className="settings-footnote">
                Safety reporting contact: <a href="mailto:jettuf26@gmail.com">Jett Nguyen (jettuf26@gmail.com)</a>
              </p>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <h2>Sign out</h2>
              <p>Sign out of your Nightlink account on this device.</p>
            </div>
            <div className="settings-section-body">
              <button
                type="button"
                className="primary-btn password-btn"
                onClick={async () => { try { await supabase.auth.signOut(); } catch { /* ignore */ } }}
              >
                Sign out
              </button>
            </div>
          </section>

          <div className="more-options-section">
            <button
              type="button"
              className="more-options-toggle"
              onClick={() => setMoreOptionsOpen((o) => !o)}
              aria-expanded={moreOptionsOpen}
            >
              More Options
              <span className={`more-options-chevron${moreOptionsOpen ? ' open' : ''}`} aria-hidden="true" />
            </button>
            {moreOptionsOpen && (
              <section className="settings-section danger-zone">
                <div className="settings-section-head">
                  <h2>Delete account</h2>
                  <p>Permanently remove your account and all associated data.</p>
                </div>
                <div className="settings-section-body">
                  <p className="settings-footnote-delete">This action cannot be undone. You will be asked to type DELETE to confirm.</p>
                  <button type="button" className="danger-btn" onClick={handleDeleteAccount} disabled={deletingAccount}>
                    {deletingAccount ? 'Deleting account...' : 'Delete account permanently'}
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {deleteConfirmOpen && (
        <ConfirmModal
          title="Delete account?"
          message="This will permanently remove your account and all associated data. This cannot be undone."
          confirmLabel={deletingAccount ? 'Deleting…' : 'Delete account'}
          cancelLabel="Cancel"
          danger
          inputLabel='Type "DELETE" to confirm'
          inputPlaceholder="DELETE"
          inputValue={deleteInput}
          onInputChange={setDeleteInput}
          confirmDisabled={deleteInput !== 'DELETE' || deletingAccount}
          onConfirm={executeDeleteAccount}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

Settings.propTypes = {
  user: appUserPropType
};
