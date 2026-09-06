// Speech-to-text for the in-app voice recorder.
//
// The client records audio (MediaRecorder) and posts it here as base64 JSON
// rather than multipart: the plain JSON path is what every other endpoint in
// this app already uses, and it avoids the raw-body handling that serverless
// body parsing makes fragile.
//
// Required env vars:
//   OPENAI_API_KEY:             same key the analysis endpoint uses
//   SUPABASE_URL:               project URL
//   SUPABASE_SERVICE_ROLE_KEY: service role key (never exposed to the client)
// Optional:
//   OPENAI_TRANSCRIBE_MODEL:    defaults to gpt-4o-mini-transcribe

const { createClient } = require('@supabase/supabase-js');

const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';

// Base64 inflates ~33%, so this caps decoded audio near 3.5 MB, roughly a
// minute of speech at any bitrate a browser will realistically produce.
const MAX_BASE64_LENGTH = 5_000_000;

const EXTENSION_MIME = {
  webm: 'audio/webm',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  mpga: 'audio/mpeg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

// Per-user throttle. Every request costs real money upstream, and unlike the
// analysis endpoint there is no credit quota in front of this one. In-memory so
// it is per serverless instance rather than global, which is enough to stop a runaway
// client or a naive script, not a substitute for platform rate limiting.
const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT_MAX = 20;
const recentByUser = new Map();

const isRateLimited = (uid) => {
  const now = Date.now();
  const hits = (recentByUser.get(uid) || []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    recentByUser.set(uid, hits);
    return true;
  }
  hits.push(now);
  recentByUser.set(uid, hits);

  // Opportunistic sweep so the map cannot grow without bound on a warm instance.
  if (recentByUser.size > 500) {
    for (const [key, times] of recentByUser) {
      if (!times.some((at) => now - at < RATE_LIMIT_WINDOW_MS)) recentByUser.delete(key);
    }
  }
  return false;
};

const getSupabaseAdmin = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const setCors = (res, origin) => {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
};

module.exports = async function handler(req, res) {
  setCors(res, req.headers?.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { audio, extension, mimeType } = body || {};
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: 'Missing audio.' });
  }
  if (audio.length > MAX_BASE64_LENGTH) {
    return res.status(413).json({ error: 'That recording is too long to transcribe.' });
  }

  // Any signed-in user may transcribe; the token is verified, not just trusted.
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  let callerId;
  try {
    const { data: { user }, error: authError } = await getSupabaseAdmin().auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid session.' });
    callerId = user.id;
  } catch {
    return res.status(401).json({ error: 'Invalid session.' });
  }

  if (isRateLimited(callerId)) {
    return res.status(429).json({ error: 'Too many voice notes just now. Give it a minute.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Voice input is not configured.' });

  const safeExtension = Object.prototype.hasOwnProperty.call(EXTENSION_MIME, extension) ? extension : 'webm';
  const contentType = (typeof mimeType === 'string' && mimeType.startsWith('audio/'))
    ? mimeType
    : EXTENSION_MIME[safeExtension];

  let buffer;
  try {
    buffer = Buffer.from(audio, 'base64');
  } catch {
    return res.status(400).json({ error: 'Audio payload could not be decoded.' });
  }
  if (!buffer.length) return res.status(400).json({ error: 'Audio payload was empty.' });

  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType }), `voice-note.${safeExtension}`);
    form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_MODEL);
    form.append('response_format', 'text');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);

    let upstream;
    try {
      upstream = await fetch(TRANSCRIBE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error('Transcription upstream failed', upstream.status, raw.slice(0, 300));
      return res.status(502).json({ error: 'Could not transcribe that recording.' });
    }

    // response_format=text returns a bare string, but keep JSON tolerated in
    // case the model or format default changes underneath us.
    let text = raw.trim();
    if (text.startsWith('{')) {
      try { text = (JSON.parse(text).text || '').trim(); } catch { /* keep raw */ }
    }

    return res.status(200).json({ text });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    console.error('Transcription failed', error?.message || error);
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? 'Transcription timed out. Try a shorter recording.' : 'Could not transcribe that recording.',
    });
  }
};
