import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { supabase } from '../supabase';
import { InsightsSkeleton } from '../components/SkeletonLoader';
import { appUserPropType } from '../propTypes';
import { useRcCustomerInfo } from '../contexts/SubscriptionContext';
import { isProFromCustomerInfo, IS_RC_SUPPORTED } from '../utils/purchases';
import './DreamInsights.css';

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

const SECTION_ORDER = [
  'Recurring symbols',
  'Recurring figures & people',
  'Emotional patterns',
  'Life themes (inferred)',
  'Notable narratives',
];

const SECTION_ICONS = {
  'Recurring symbols': '◈',
  'Recurring figures & people': '◉',
  'Emotional patterns': '◍',
  'Life themes (inferred)': '◌',
  'Notable narratives': '◎',
};

// Parse the memory markdown into sections
const parseMemory = (text) => {
  if (!text) return {};
  const sections = {};
  let currentSection = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      currentSection = line.slice(3).trim();
      sections[currentSection] = [];
    } else if (currentSection && line.trim()) {
      sections[currentSection].push(line.trim().replace(/^[-•*]\s*/, ''));
    }
  }
  return sections;
};

// Render inline markdown. Handles **bold** only (memory format uses nothing else)
const renderInline = (text) => {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
};

// Pull count hints out of an entry string like "water: ~8 times"
const extractCount = (entry) => {
  const m = entry.match(/~?(\d+)\s*time/i);
  return m ? parseInt(m[1], 10) : null;
};

export default function DreamInsights({ user }) {
  const [loading, setLoading] = useState(true);
  const [isPro, setIsPro] = useState(false);
  const [memory, setMemory] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [error, setError] = useState('');
  const { rcCustomerInfo } = useRcCustomerInfo();
  const navigate = useNavigate();
  const isNativeIOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

  useEffect(() => {
    if (!user?.uid) return;

    const load = async () => {
      setLoading(true);
      try {
        const { data, error: err } = await supabase
          .from('profiles')
          .select('subscription, dream_memory, dream_memory_updated_at')
          .eq('id', user.uid)
          .single();

        if (err) throw err;

        // Check RevenueCat (iOS native) first
        const rcPro = IS_RC_SUPPORTED && isProFromCustomerInfo(rcCustomerInfo);

        // Check Supabase profile tier
        let supabaseTier = data?.subscription?.tier === 'premium' ? 'premium' : 'free';

        // If still free, call sync_subscription_tier to get the authoritative tier
        // (handles PREMIUM_EMAILS env var and any stale profile data)
        if (!rcPro && supabaseTier !== 'premium' && user.getIdToken) {
          try {
            const idToken = await user.getIdToken();
            if (idToken) {
              const res = await fetch(ACCOUNT_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                body: JSON.stringify({ action: 'sync_subscription_tier', uid: user.uid }),
              });
              const payload = await res.json().catch(() => ({}));
              if (res.ok && payload?.success && payload?.tier) {
                supabaseTier = payload.tier;
              }
            }
          } catch { /* non-critical */ }
        }

        setIsPro(rcPro || supabaseTier === 'premium');
        setMemory(data?.dream_memory || null);
        setUpdatedAt(data?.dream_memory_updated_at ? new Date(data.dream_memory_updated_at) : null);
      } catch (e) {
        setError('Could not load your dream patterns.');
        console.error(e);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [user?.uid]);

  // RevenueCat customer info can land after the initial load, and without this a
  // Pro subscriber who opens Insights directly stays stuck behind the gate.
  useEffect(() => {
    if (IS_RC_SUPPORTED && isProFromCustomerInfo(rcCustomerInfo)) setIsPro(true);
  }, [rcCustomerInfo]);

  const backButton = !isNativeIOS && (
    <button type="button" className="detail-back-btn insights-back-btn" onClick={() => navigate(-1)}>
      <span className="detail-back-icon" aria-hidden="true">&larr;</span>
      <span>Go back</span>
    </button>
  );

  if (loading) return <InsightsSkeleton />;

  if (!isPro) {
    return (
      <div className="insights-page">
        {backButton}
        <div className="insights-gate">
          <div className="insights-gate-icon">◈</div>
          <h2>Dream Pattern Intelligence</h2>
          <p>Pro members build a private memory file across every dream they analyze. Over time, the AI surfaces recurring symbols, emotional patterns, and life themes, giving you a living map of your inner world.</p>
          <p className="insights-gate-sub">Upgrade to Pro to unlock this feature.</p>
          <button type="button" className="primary-btn" onClick={() => navigate('/settings')}>
            Go to Settings
          </button>
        </div>
      </div>
    );
  }

  const sections = parseMemory(memory);
  const hasSections = Object.keys(sections).length > 0;

  return (
    <div className="insights-page">
      {backButton}
      <div className="insights-header">
        <h1 className="insights-title">Dream Patterns</h1>
        {updatedAt ? (
          <p className="insights-updated">Last updated {format(updatedAt, 'MMM d, yyyy')}</p>
        ) : (
          <p className="insights-updated">Updates after each Pro analysis</p>
        )}
      </div>

      {error && <p className="insights-error">{error}</p>}

      {!hasSections ? (
        <div className="insights-empty">
          <div className="insights-empty-icon">◌</div>
          <h3>No patterns yet</h3>
          <p>Generate your first AI analysis on a dream to start building your pattern file. The more dreams you analyze, the richer this becomes.</p>
        </div>
      ) : (
        <div className="insights-sections">
          {SECTION_ORDER.filter((s) => sections[s]?.length > 0).map((section) => {
            const entries = sections[section];
            const icon = SECTION_ICONS[section] || '◎';
            return (
              <div key={section} className="insights-card">
                <div className="insights-card-header">
                  <span className="insights-card-icon">{icon}</span>
                  <h2 className="insights-card-title">{section}</h2>
                  <span className="insights-card-count">{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
                </div>
                <ul className="insights-entries">
                  {entries.map((entry, i) => {
                    const count = extractCount(entry);
                    return (
                      <li key={i} className="insights-entry">
                        <span className="insights-entry-text">{renderInline(entry)}</span>
                        {count !== null && count >= 3 && (
                          <span className="insights-entry-badge">{count}×</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          {/* Any sections from memory not in the standard order */}
          {Object.keys(sections)
            .filter((s) => !SECTION_ORDER.includes(s) && sections[s]?.length > 0)
            .map((section) => (
              <div key={section} className="insights-card">
                <div className="insights-card-header">
                  <span className="insights-card-icon">◎</span>
                  <h2 className="insights-card-title">{section}</h2>
                </div>
                <ul className="insights-entries">
                  {sections[section].map((entry, i) => (
                    <li key={i} className="insights-entry">
                      <span className="insights-entry-text">{renderInline(entry)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

DreamInsights.propTypes = {
  user: appUserPropType.isRequired,
};
