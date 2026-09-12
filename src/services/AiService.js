import { Capacitor } from '@capacitor/core';
import { supabase } from '../supabase';

const DEFAULT_API_ORIGIN = 'https://www.nightlink.dev';

// The apex answers the browser but not the native shell, which follows the
// redirect and loses the POST body on the way.
const normalizeNativeAiEndpoint = (endpoint) => (
  endpoint.replace(/^https:\/\/nightlink\.dev(?=\/|$)/i, 'https://www.nightlink.dev')
);

export const resolveAiEndpoint = () => {
  const configuredAiEndpoint = (import.meta.env.VITE_AI_ENDPOINT || '').trim();
  if (configuredAiEndpoint) return normalizeNativeAiEndpoint(configuredAiEndpoint);

  const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || '').trim();
  if (configuredApiBase) {
    return normalizeNativeAiEndpoint(`${configuredApiBase.replace(/\/$/, '')}/api/ai`);
  }

  if (Capacitor.isNativePlatform()) return `${DEFAULT_API_ORIGIN}/api/ai`;
  return '/api/ai';
};

/**
 * Asks the analysis service for a title and a reading of a dream.
 *
 * `dreamId` is optional on purpose: the new dream sheet generates before the
 * row exists, and the only thing the id buys is memory indexing for premium
 * accounts, which the detail page still does on a later generation. Everything
 * else, quota included, works the same without it.
 *
 * Throws an Error whose message is safe to show. Quota and locked-style
 * refusals carry a `code` so the caller can react rather than only report.
 */
export const requestDreamAnalysis = async ({
  dreamText,
  promptStyle = 'balanced',
  customPrompt = '',
  dreamId = null,
  dreamDate = null,
}) => {
  const text = (dreamText || '').trim();
  if (!text) throw new Error('Write the dream first, then generate.');

  const { data: sessionData } = await supabase.auth.getSession();
  const idToken = sessionData?.session?.access_token;
  if (!idToken) throw new Error('Please sign in again to use AI features.');

  const body = { dreamText: text, idToken, promptStyle };
  if (customPrompt) body.customPrompt = customPrompt;
  if (dreamId) body.dreamId = dreamId;
  if (dreamDate) body.dreamDate = dreamDate;

  const response = await fetch(resolveAiEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html') || raw.trimStart().startsWith('<!DOCTYPE html')) {
    throw new Error('AI service endpoint is misconfigured for this build.');
  }

  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    // A gateway that never reached the function answers in plain text. That is
    // the service being down, not a malformed payload.
    if (response.status >= 502 && response.status <= 504) {
      throw new Error('The analysis service is unavailable right now. Please try again in a moment.');
    }
    throw new Error(`Analysis service error (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const error = new Error(payload?.error || `Analysis service error (HTTP ${response.status}).`);
    error.code = payload?.code || null;
    if (response.status === 429 && payload?.code === 'quota_exceeded') {
      error.message = 'Monthly limit reached. Upgrade or buy credits in Settings to keep analyzing.';
    }
    throw error;
  }

  return {
    title: (payload?.title || '').trim(),
    insights: (payload?.themes || payload?.summary || payload?.insights || '').trim(),
    tier: payload?.tier || 'free',
    remainingFree: payload?.remainingFree ?? null,
    creditBalance: payload?.creditBalance ?? 0,
  };
};

export default requestDreamAnalysis;
