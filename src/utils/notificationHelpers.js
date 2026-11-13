import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { supabase } from '../supabase';
import { fetchOwnProfile } from './profileReads';

const DREAM_REMINDER_ID = 99001;

const isNative = () => Capacitor.isNativePlatform();

const getActivityNotificationCopy = (entry = {}) => {
  const actor = entry.actorDisplayName || 'Someone';
  const dreamTitle = entry.dreamTitleSnapshot || 'your dream';
  switch (entry.type) {
    case 'follow':
      return { title: `${actor} followed you`, body: 'Open Nightlink to see their profile.' };
    case 'reply':
      return { title: `${actor} replied`, body: `On ${dreamTitle}` };
    case 'comment':
      return { title: `${actor} commented`, body: `On ${dreamTitle}` };
    case 'commentReaction':
      return { title: `${actor} reacted to your comment`, body: entry.emoji ? `Reaction: ${entry.emoji}` : 'Open Nightlink to see details.' };
    case 'reaction':
      return { title: `${actor} reacted to your dream`, body: entry.emoji ? `Reaction: ${entry.emoji}` : `On ${dreamTitle}` };
    case 'dreamUpdate':
      return { title: `${actor} posted an update`, body: `On ${dreamTitle}` };
    case 'mention':
    default:
      return { title: `${actor} mentioned you`, body: `In ${dreamTitle}` };
  }
};

const activityIdToNotificationId = (activityId = '') => {
  const safe = String(activityId || '0');
  let hash = 0;
  for (let i = 0; i < safe.length; i += 1) {
    hash = ((hash << 5) - hash) + safe.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 2000000000;
};

const upsertUserPushToken = async (userId, token) => {
  if (!userId || !token) return;
  const profile = await fetchOwnProfile(userId);
  // Unreadable: writing these back would wipe the other tokens and settings.
  if (!profile) return;

  const existingTokens = Array.isArray(profile?.fcm_tokens) ? profile.fcm_tokens : [];
  const nextTokens = [...new Set([...existingTokens, token])];

  let pushTimezone = profile?.settings?.pushTimezone;
  if (!pushTimezone) {
    try { pushTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* ignore */ }
  }

  const nextSettings = {
    ...(profile?.settings || {}),
    notificationsEnabled: true,
    ...(pushTimezone ? { pushTimezone } : {}),
  };

  await supabase
    .from('profiles')
    .update({
      fcm_tokens: nextTokens,
      settings: nextSettings,
    })
    .eq('id', userId);
};

const removeUserPushToken = async (userId, token) => {
  if (!userId || !token) return;
  const profile = await fetchOwnProfile(userId);
  if (!profile) return;
  const existingTokens = Array.isArray(profile?.fcm_tokens) ? profile.fcm_tokens : [];
  const nextTokens = existingTokens.filter((value) => value !== token);
  await supabase
    .from('profiles')
    .update({ fcm_tokens: nextTokens })
    .eq('id', userId);
};

const registerNativePushToken = async () => {
  return new Promise((resolve, reject) => {
    let resolved = false;

    (async () => {
      const registrationListener = await PushNotifications.addListener('registration', (token) => {
        if (resolved) return;
        resolved = true;
        registrationListener.remove();
        errorListener.remove();
        resolve(token?.value || null);
      });

      const errorListener = await PushNotifications.addListener('registrationError', (error) => {
        if (resolved) return;
        resolved = true;
        registrationListener.remove();
        errorListener.remove();
        reject(error);
      });

      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        registrationListener.remove();
        errorListener.remove();
        resolve(null);
      }, 7000);

      await PushNotifications.register();
    })().catch((error) => {
      if (resolved) return;
      resolved = true;
      reject(error);
    });
  });
};

export async function getNotificationPermissionStatus() {
  if (isNative()) {
    const push = await PushNotifications.checkPermissions();
    if (push.receive === 'granted') return 'granted';
    if (push.receive === 'denied') return 'denied';
    return 'default';
  }
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied';
  }
  return Notification.permission;
}

/**
 * Request notification permission and get native push token when available
 * @param {string} userId - The authenticated user's ID
 * @returns {Promise<string|null>} - Push token or enabled marker when permission granted
 */
export async function requestNotificationPermission(userId) {
  if (isNative()) {
    const pushPermission = await PushNotifications.requestPermissions();
    const localPermission = await LocalNotifications.requestPermissions();
    if (pushPermission.receive !== 'granted' && localPermission.display !== 'granted') {
      return null;
    }

    const token = await registerNativePushToken();
    if (token) {
      localStorage.setItem('nightlink_push_token', token);
      await upsertUserPushToken(userId, token);
      return token;
    }
    return 'enabled-local-only';
  }

  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  const profile = userId ? await fetchOwnProfile(userId) : null;
  if (profile) {
    await supabase
      .from('profiles')
      .update({
        settings: {
          ...(profile.settings || {}),
          notificationsEnabled: true,
        },
      })
      .eq('id', userId);
  }

  return 'enabled-web';
}

/**
 * Disable notifications for the current device
 * @param {string} userId - The authenticated user's ID
 */
export async function disableNotifications(userId) {
  try {
    if (isNative()) {
      const token = localStorage.getItem('nightlink_push_token');
      if (token && userId) {
        await removeUserPushToken(userId, token);
      }
      localStorage.removeItem('nightlink_push_token');
      await syncDailyDreamReminder(false);
      return;
    }

    const profile = userId ? await fetchOwnProfile(userId) : null;
    if (profile) {
      const nextSettings = {
        ...(profile.settings || {}),
        notificationsEnabled: false,
      };

      await supabase
        .from('profiles')
        .update({
          settings: nextSettings,
        })
        .eq('id', userId);
    }
  } catch (error) {
    console.error('Error disabling notifications:', error);
    throw error;
  }
}

/**
 * Listen for foreground messages
 * @param {Function} callback - Function to call when message received
 */
export function onForegroundMessage(callback) {
  void callback;
  return () => {};
}

/**
 * Check if notifications are supported and enabled
 * @returns {boolean}
 */
export function areNotificationsSupported() {
  if (isNative()) return true;
  if (typeof window === 'undefined') return false;
  return 'Notification' in window;
}

/**
 * Check current notification permission status
 * @returns {'granted' | 'denied' | 'default'}
 */
export function getNotificationPermission() {
  if (isNative()) return 'default';
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
  return Notification.permission;
}

export async function syncDailyDreamReminder(enabled, hour = 9) {
  if (!isNative()) return;

  await LocalNotifications.cancel({ notifications: [{ id: DREAM_REMINDER_ID }] });
  if (!enabled) return;

  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== 'granted') {
    const requested = await LocalNotifications.requestPermissions();
    if (requested.display !== 'granted') return;
  }

  const safeHour = Math.max(0, Math.min(23, Math.round(hour)));
  await LocalNotifications.schedule({
    notifications: [{
      id: DREAM_REMINDER_ID,
      title: 'Did you have a dream?',
      body: 'Log it in Nightlink before it fades.',
      schedule: {
        on: { hour: safeHour, minute: 0 },
        repeats: true,
      },
      extra: { type: 'dream-reminder' },
    }],
  });
}

export async function pushActivityLocalNotification(entry) {
  if (!isNative() || !entry?.id) return;

  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== 'granted') return;

  const copy = getActivityNotificationCopy(entry);
  await LocalNotifications.schedule({
    notifications: [{
      id: activityIdToNotificationId(entry.id),
      title: copy.title,
      body: copy.body,
      schedule: { at: new Date(Date.now() + 150) },
      extra: {
        type: 'activity',
        activityId: entry.id,
        dreamId: entry.dreamId || null,
      },
    }],
  });
}
