/**
 * Apple Push Notification service (APNs) helpers.
 * Uses the HTTP/2 provider API with JWT authentication.
 */

const APNS_KEY     = Deno.env.get('APNS_KEY')!;
const APNS_KEY_ID  = Deno.env.get('APNS_KEY_ID')!;
const APNS_TEAM_ID = Deno.env.get('APNS_TEAM_ID')!;
const APNS_BUNDLE  = Deno.env.get('APNS_BUNDLE_ID') ?? 'dev.nightlink';
const APNS_HOST    = Deno.env.get('APNS_ENV') === 'production'
  ? 'api.push.apple.com'
  : 'api.sandbox.push.apple.com';

// Cache the JWT so we don't re-sign on every notification within the same invocation.
let cachedJwt: { token: string; issuedAt: number } | null = null;

function base64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateApnsJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Reuse token if it was issued less than 55 minutes ago (tokens expire after 60 min).
  if (cachedJwt && now - cachedJwt.issuedAt < 55 * 60) return cachedJwt.token;

  const header  = base64url(JSON.stringify({ alg: 'ES256', kid: APNS_KEY_ID }));
  const payload = base64url(JSON.stringify({ iss: APNS_TEAM_ID, iat: now }));
  const sigInput = `${header}.${payload}`;

  // Strip PEM wrapper and decode the PKCS#8 key.
  const pem = APNS_KEY.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\r|\n/g, '');
  const keyBytes = Uint8Array.from(atob(pem), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(sigInput),
  );

  const token = `${sigInput}.${base64url(sig)}`;
  cachedJwt = { token, issuedAt: now };
  return token;
}

export interface ApnsResult {
  ok: boolean;
  token: string;
  error?: string;
}

export async function sendApns(
  deviceToken: string,
  title: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<ApnsResult> {
  try {
    const jwt = await generateApnsJwt();
    const res = await fetch(`https://${APNS_HOST}/3/device/${deviceToken}`, {
      method: 'POST',
      headers: {
        'authorization':  `bearer ${jwt}`,
        'apns-topic':     APNS_BUNDLE,
        'apns-push-type': 'alert',
        'apns-priority':  '10',
        'content-type':   'application/json',
      },
      body: JSON.stringify({
        // NightLink's own sound, bundled in the iOS app. A phone on a build
        // without it plays the default sound instead, so this is safe to send
        // before everyone has updated.
        aps: { alert: { title, body }, sound: 'nightlink.caf', badge: 1 },
        ...extra,
      }),
    });

    if (res.ok) return { ok: true, token: deviceToken };

    const err = await res.json().catch(() => ({ reason: 'unknown' }));
    return { ok: false, token: deviceToken, error: (err as Record<string, string>).reason };
  } catch (e) {
    return { ok: false, token: deviceToken, error: String(e) };
  }
}

export function getNotificationCopy(payload: Record<string, unknown>): { title: string; body: string } {
  const actor      = String(payload.actorDisplayName || 'Someone');
  const dreamTitle = String(payload.dreamTitleSnapshot || 'your dream');
  const emoji      = payload.emoji ? ` ${payload.emoji}` : '';

  switch (payload.type) {
    case 'follow':          return { title: `${actor} followed you`,               body: 'Open Nightlink to see their profile.' };
    case 'reply':           return { title: `${actor} replied`,                    body: `On "${dreamTitle}"` };
    case 'comment':         return { title: `${actor} commented`,                  body: `On "${dreamTitle}"` };
    case 'commentReaction': return { title: `${actor} reacted to your comment`,    body: `${emoji || 'Open Nightlink to see details.'}` };
    case 'reaction':        return { title: `${actor} reacted to your dream`,      body: `${emoji} on "${dreamTitle}"`.trim() };
    case 'dreamUpdate':     return { title: `${actor} posted an update`,           body: `On "${dreamTitle}"` };
    case 'mention':         return { title: `${actor} mentioned you`,              body: `In "${dreamTitle}"` };
    default:                return { title: 'New activity on Nightlink',           body: 'Open the app to see what happened.' };
  }
}
