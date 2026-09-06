/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname, process */
// dev-server.js: local API shim for /api endpoints used by the frontend
// Loads .env.local if present and starts an Express server that delegates
// requests to handlers in the `api/` folder.

// Load local env vars from project root .env.local for local dev
try {
  const path = require('path');
  const fs = require('fs');
  const dotenvPath = path.resolve(__dirname, '.env.local');
  if (fs.existsSync(dotenvPath)) {
    require('dotenv').config({ path: dotenvPath });
    console.log(`[dev] dev-server loaded .env.local from ${dotenvPath}`);
  } else {
    require('dotenv').config();
    console.log('[dev] dev-server did not find .env.local at', dotenvPath);
  }
} catch (e) {
  // ignore
  void e;
}

const express = require('express');
const rateLimit = require('express-rate-limit');
const aiHandler = require('./api/ai');
const accountHandler = require('./api/account');
const stripeHandler = require('./api/stripe');
const transcribeHandler = require('./api/transcribe');
const notifyHandler = require('./api/notify');

// Per-IP rate limits for dev server (mirrors production platform-level limits)
const defaultLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const aiLimiter     = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
const stripeLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
const transcribeLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

// debug: show whether key is present (never print the key)
try { console.log('[dev] dev-server OPENAI_API_KEY present:', !!process.env.OPENAI_API_KEY); } catch (e) { void e; }

const app = express();
app.use(express.json({ limit: '1mb' }));

const routeHandler = (label, handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[dev] ${label} handler error:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

app.options('/api/ai', (req, res) => res.sendStatus(204));
app.options('/api/account', (req, res) => res.sendStatus(204));
app.options('/api/stripe', (req, res) => res.sendStatus(204));
app.options('/api/notify', (req, res) => res.sendStatus(204));
app.options('/api/transcribe', (req, res) => res.sendStatus(204));

app.post('/api/ai', aiLimiter, routeHandler('ai', aiHandler));
app.post('/api/account', defaultLimiter, routeHandler('account', accountHandler));
app.post('/api/stripe', stripeLimiter, routeHandler('stripe', stripeHandler));
app.post('/api/notify', defaultLimiter, routeHandler('notify', notifyHandler));
// Base64 audio outgrows the shared 1mb parser, so this route gets its own.
app.post('/api/transcribe', transcribeLimiter, express.json({ limit: '8mb' }), routeHandler('transcribe', transcribeHandler));

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Dev API listening on http://localhost:${port}`);
});
