import { registerPlugin, Capacitor } from '@capacitor/core';

/**
 * Bridge to `NativeSpeechPlugin.swift`, which wraps Apple's Speech framework.
 *
 * Only the iOS shell implements dictation. Everywhere else voice input falls
 * back to the record-then-upload path in `useVoiceCapture`. The Android shell
 * has `keepAwake` alone (`NativeSpeechPlugin.java`), to hold the screen on
 * while that recording runs.
 */
const NativeSpeech = registerPlugin('NativeSpeech');

export const isNativeSpeechPlatform = () => (
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
);

/**
 * Availability is stable for the life of the process once the user has answered
 * the permission prompts, and it costs a bridge round trip, so it is cached.
 */
let capabilityPromise = null;

export const getNativeSpeechCapability = () => {
  if (!isNativeSpeechPlatform()) return Promise.resolve({ available: false });
  if (!capabilityPromise) {
    capabilityPromise = NativeSpeech.available().catch(() => ({ available: false }));
  }
  return capabilityPromise;
};

/** Called after a permission prompt, whose answer changes the cached result. */
export const resetNativeSpeechCapability = () => { capabilityPromise = null; };

export default NativeSpeech;
