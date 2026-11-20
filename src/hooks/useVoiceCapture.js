import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { supabase } from '../supabase';
import NativeSpeech, {
  getNativeSpeechCapability,
  isNativeSpeechPlatform,
  resetNativeSpeechCapability,
} from '../plugins/nativeSpeech';

const DEFAULT_API_ORIGIN = 'https://www.nightlink.dev';

const resolveTranscribeEndpoint = () => {
  const base = (import.meta.env.VITE_API_BASE_URL || '').trim();
  if (base) return `${base.replace(/\/$/, '')}/api/transcribe`;
  if (Capacitor.isNativePlatform()) return `${DEFAULT_API_ORIGIN}/api/transcribe`;
  return '/api/transcribe';
};

const TRANSCRIBE_ENDPOINT = resolveTranscribeEndpoint();

// Hard stop so a forgotten recording can't run up an unbounded upload or bill.
// Apple's recogniser also refuses to run a single request much past a minute.
export const MAX_RECORDING_MS = 60_000;
// Comfortably inside Vercel's 4.5 MB request ceiling once base64 inflates it ~33%.
const MAX_BLOB_BYTES = 3_500_000;

// Safari/WKWebView only produce mp4/aac; Chrome and Firefox prefer webm/opus.
// OpenAI keys off the filename extension, so keep the pairing together.
const CANDIDATE_TYPES = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
  { mimeType: 'audio/mp4', extension: 'mp4' },
  { mimeType: 'audio/aac', extension: 'aac' },
  { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
];

const pickRecordingType = () => {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported?.(candidate.mimeType)) return candidate;
  }
  // Some WKWebView builds report nothing as supported but still record the
  // platform default, so fall through and let the recorder choose.
  return { mimeType: '', extension: 'mp4' };
};

const isUploadCaptureSupported = () => (
  typeof navigator !== 'undefined'
  && Boolean(navigator.mediaDevices?.getUserMedia)
  && typeof MediaRecorder !== 'undefined'
);

export const isVoiceCaptureSupported = () => (
  isNativeSpeechPlatform() || isUploadCaptureSupported()
);

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('Could not read the recording.'));
  reader.onload = () => {
    const result = String(reader.result || '');
    const comma = result.indexOf(',');
    resolve(comma === -1 ? result : result.slice(comma + 1));
  };
  reader.readAsDataURL(blob);
});

const friendlyMicError = (error) => {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Enable it for Nightlink in your settings.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found on this device.';
  }
  if (name === 'NotReadableError') {
    return 'Your microphone is busy in another app.';
  }
  return 'Could not start recording. Please try again.';
};

const MIC_DENIED = 'Microphone access was denied. Enable it for Nightlink in your settings.';
const NO_SPEECH = 'No speech was detected. Try again a little closer to the mic.';

// What to say when a recording ends without the user tapping stop. Their words
// are already in the entry by then, so each one says how to add more.
const STOP_NOTICES = {
  limit: 'Recordings stop at one minute. Tap the mic to add more.',
  background: 'Recording stopped when you left the app. Tap the mic to add more.',
  interrupted: 'Recording stopped for a call or alert. Tap the mic to add more.',
  ended: 'Recording stopped early. Tap the mic to add more.',
};

/**
 * Keeps the screen on for the upload engine, and returns the call that lets it
 * sleep again. The live engine holds the screen on natively. Without this, auto
 * lock puts the phone to sleep while someone is still talking. Both apps ask
 * their own shell, since Android's web view has no screen wake lock.
 */
const holdScreenAwake = () => {
  if (Capacitor.isNativePlatform()) {
    NativeSpeech.keepAwake({ on: true }).catch(() => {});
    return () => { NativeSpeech.keepAwake({ on: false }).catch(() => {}); };
  }

  let lock = null;
  let released = false;
  try {
    const pending = navigator.wakeLock?.request?.('screen');
    pending?.then((sentinel) => {
      if (released) sentinel.release().catch(() => {});
      else lock = sentinel;
    }).catch(() => {});
  } catch { /* not offered here */ }

  return () => {
    released = true;
    lock?.release().catch(() => {});
    lock = null;
  };
};

/**
 * Records a voice note and returns the transcript.
 *
 * Two engines sit behind one interface:
 *
 * - `live` (iOS only) drives Apple's `SFSpeechRecognizer` through a local
 *   Capacitor plugin. Words stream back while the user is still talking, it
 *   costs nothing per use, and on locales with a downloaded model the audio
 *   never leaves the phone.
 * - `upload` records with `MediaRecorder` and posts to `/api/transcribe`. This
 *   is what the web build uses, and what iOS falls back to if the recogniser is
 *   unavailable. Deliberately not the Web Speech API, which does not exist in
 *   the WKWebView Capacitor runs.
 *
 * `analyserRef` (upload) and `levelRef` (live) both expose live amplitude so a
 * visualiser can read it per frame without pushing state through React.
 */
export default function useVoiceCapture({ onTranscript, onError, onNotice } = {}) {
  const [status, setStatus] = useState('idle'); // idle | starting | recording | transcribing
  const [error, setError] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  // The words heard so far, while the user is still speaking. Only ever
  // populated by the live engine.
  const [interimText, setInterimText] = useState('');
  const [mode, setMode] = useState('upload'); // upload | live

  const analyserRef = useRef(null);
  const levelRef = useRef(0);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const chunksRef = useRef([]);
  const extensionRef = useRef('webm');
  const cancelledRef = useRef(false);
  const autoStopRef = useRef(null);
  const tickRef = useRef(null);
  const startedAtRef = useRef(0);
  const unmountedRef = useRef(false);
  const releaseWakeRef = useRef(null);
  // Why the current recording is ending, when the page is the one ending it.
  const stopReasonRef = useRef('user');

  const modeRef = useRef('upload');
  const interimRef = useRef('');
  const listenersRef = useRef([]);
  // True from the native start until the recording settles. The native side
  // can answer twice, with its finalResult event and the stop() promise, and
  // only the first one may put words in the entry.
  const liveOpenRef = useRef(false);
  // `start` and `stop` reference each other through the auto-stop timer, so the
  // timer reads the current stop through a ref instead of closing over it.
  const stopRef = useRef(null);

  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  const onNoticeRef = useRef(onNotice);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onNoticeRef.current = onNotice; }, [onNotice]);

  const clearTimers = useCallback(() => {
    if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const releaseAudio = useCallback(() => {
    clearTimers();
    releaseWakeRef.current?.();
    releaseWakeRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') context.close().catch(() => {});
  }, [clearTimers]);

  const detachNativeListeners = useCallback(() => {
    const handles = listenersRef.current;
    listenersRef.current = [];
    handles.forEach((handle) => { try { handle?.remove?.(); } catch { /* already gone */ } });
  }, []);

  useEffect(() => () => {
    unmountedRef.current = true;
    cancelledRef.current = true;
    try { recorderRef.current?.stop(); } catch { /* already inactive */ }
    detachNativeListeners();
    liveOpenRef.current = false;
    if (modeRef.current === 'live') NativeSpeech.cancel().catch(() => {});
    releaseAudio();
  }, [releaseAudio, detachNativeListeners]);

  const fail = useCallback((message) => {
    if (unmountedRef.current) return;
    setStatus('idle');
    setError(message);
    onErrorRef.current?.(message);
  }, []);

  const deliver = useCallback((text, reason) => {
    onTranscriptRef.current?.(text);
    const notice = STOP_NOTICES[reason];
    if (notice) onNoticeRef.current?.(notice);
  }, []);

  const beginTimers = useCallback(() => {
    startedAtRef.current = Date.now();
    tickRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 200);
    autoStopRef.current = setTimeout(() => { stopRef.current?.('limit'); }, MAX_RECORDING_MS);
  }, []);

  // ── Live engine (iOS) ────────────────────────────────────────────────────

  /**
   * `reason` is the native one: `stopped` when the page asked, which then takes
   * the page's own reason, or `background`, `interrupted` or `ended` when the
   * phone ended the recording by itself.
   */
  const settleLive = useCallback((text, reason) => {
    if (!liveOpenRef.current) return;
    liveOpenRef.current = false;
    clearTimers();
    detachNativeListeners();
    interimRef.current = '';
    levelRef.current = 0;
    if (unmountedRef.current) return;
    setInterimText('');
    setStatus('idle');
    const why = !reason || reason === 'stopped' ? stopReasonRef.current : reason;
    const trimmed = (text || '').trim();
    if (!trimmed) {
      // Leaving the app before saying anything is not worth a message.
      if (why !== 'background') fail(NO_SPEECH);
      return;
    }
    deliver(trimmed, why);
  }, [clearTimers, detachNativeListeners, fail, deliver]);

  /**
   * Returns true when the live engine took the recording, false when the caller
   * should fall back to the upload path.
   */
  const startLive = useCallback(async () => {
    let capability = await getNativeSpeechCapability();
    if (!capability?.available) return false;

    if (capability.speechPermission !== 'granted' || capability.micPermission !== 'granted') {
      const granted = await NativeSpeech.requestSpeechPermissions().catch(() => null);
      resetNativeSpeechCapability();
      if (granted?.micPermission === 'denied') {
        // The upload path needs the same microphone, so there is nothing to
        // fall back to.
        fail(MIC_DENIED);
        return true;
      }
      if (granted?.speechPermission !== 'granted') return false;
      capability = { ...capability, ...granted };
    }

    if (cancelledRef.current || unmountedRef.current) return true;

    try {
      listenersRef.current = await Promise.all([
        NativeSpeech.addListener('partialResult', ({ text }) => {
          interimRef.current = text || '';
          if (!unmountedRef.current) setInterimText(text || '');
        }),
        NativeSpeech.addListener('level', ({ level }) => {
          levelRef.current = typeof level === 'number' ? level : 0;
        }),
        // Every ending comes through here, including a tapped stop, whose
        // promise then finds the recording already settled with the same words.
        NativeSpeech.addListener('finalResult', ({ text, reason }) => {
          settleLive(text, reason);
        }),
        NativeSpeech.addListener('error', ({ message }) => {
          if (!liveOpenRef.current) return;
          // Never throw away words the user already said over a mid-recording
          // fault, so keep them and only surface the error when there is nothing.
          if (interimRef.current.trim()) { settleLive(interimRef.current, 'ended'); return; }
          liveOpenRef.current = false;
          clearTimers();
          detachNativeListeners();
          levelRef.current = 0;
          setInterimText('');
          fail(message || 'Dictation stopped unexpectedly. Tap the mic to try again.');
        }),
      ]);

      liveOpenRef.current = true;
      await NativeSpeech.start({ onDevice: true });
    } catch (err) {
      liveOpenRef.current = false;
      detachNativeListeners();
      if (err?.code === 'permission' || err?.code === 'unavailable' || err?.code === 'busy') {
        return false;
      }
      return false;
    }

    if (cancelledRef.current || unmountedRef.current) {
      liveOpenRef.current = false;
      detachNativeListeners();
      NativeSpeech.cancel().catch(() => {});
      return true;
    }

    modeRef.current = 'live';
    setMode('live');
    setStatus('recording');
    beginTimers();
    return true;
  }, [fail, settleLive, beginTimers, clearTimers, detachNativeListeners]);

  const stopLive = useCallback(async (reason) => {
    if (!liveOpenRef.current) return;
    stopReasonRef.current = reason;
    clearTimers();
    setStatus('transcribing');
    let text = interimRef.current;
    let nativeReason;
    try {
      const result = await NativeSpeech.stop();
      if (typeof result?.text === 'string') text = result.text;
      nativeReason = result?.reason;
    } catch { /* keep whatever the last partial held */ }
    settleLive(text, nativeReason);
  }, [clearTimers, settleLive]);

  const cancelLive = useCallback(() => {
    liveOpenRef.current = false;
    clearTimers();
    detachNativeListeners();
    NativeSpeech.cancel().catch(() => {});
    interimRef.current = '';
    levelRef.current = 0;
    if (unmountedRef.current) return;
    setInterimText('');
    setStatus('idle');
    setElapsedMs(0);
  }, [clearTimers, detachNativeListeners]);

  // ── Upload engine (web, and iOS fallback) ────────────────────────────────

  const transcribe = useCallback(async (blob, extension) => {
    if (!blob.size) { fail('Nothing was recorded. Try speaking for a moment longer.'); return; }
    if (blob.size > MAX_BLOB_BYTES) { fail('That recording is too long to transcribe. Try a shorter one.'); return; }

    setStatus('transcribing');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error('Please sign in again to use voice input.');

      const response = await fetch(TRANSCRIBE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          audio: await blobToBase64(blob),
          extension,
          mimeType: blob.type || '',
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || 'Could not transcribe that recording.');

      const text = (payload?.text || '').trim();
      if (unmountedRef.current) return;
      setStatus('idle');
      if (!text) { fail('No speech was detected in that recording.'); return; }
      deliver(text, stopReasonRef.current);
    } catch (err) {
      fail(err?.message || 'Could not transcribe that recording.');
    }
  }, [fail, deliver]);

  const startUpload = useCallback(async () => {
    if (!isUploadCaptureSupported()) { fail('Voice input is not supported on this device.'); return; }

    chunksRef.current = [];

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      fail(friendlyMicError(err));
      return;
    }

    if (cancelledRef.current || unmountedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;

    // Analyser drives the waveform. Non-fatal: recording still works without it.
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const context = new AudioCtx();
        // iOS starts contexts suspended until resumed inside a user gesture.
        if (context.state === 'suspended') await context.resume().catch(() => {});
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.75;
        context.createMediaStreamSource(stream).connect(analyser);
        audioContextRef.current = context;
        analyserRef.current = analyser;
      }
    } catch {
      analyserRef.current = null;
    }

    const type = pickRecordingType();
    extensionRef.current = type?.extension || 'webm';

    let recorder;
    try {
      const options = { audioBitsPerSecond: 32_000 };
      if (type?.mimeType) options.mimeType = type.mimeType;
      recorder = new MediaRecorder(stream, options);
    } catch {
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        releaseAudio();
        fail('Recording is not supported on this device.');
        return;
      }
    }

    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunksRef.current.push(event.data);
    };
    recorder.onerror = () => {
      releaseAudio();
      fail('Recording stopped unexpectedly.');
    };
    recorder.onstop = () => {
      const parts = chunksRef.current;
      chunksRef.current = [];
      const extension = extensionRef.current;
      releaseAudio();
      if (cancelledRef.current || unmountedRef.current) {
        if (!unmountedRef.current) setStatus('idle');
        return;
      }
      transcribe(new Blob(parts, { type: recorder.mimeType || '' }), extension);
    };

    try {
      recorder.start();
    } catch {
      releaseAudio();
      fail('Could not start recording. Please try again.');
      return;
    }

    releaseWakeRef.current = holdScreenAwake();
    modeRef.current = 'upload';
    setMode('upload');
    setStatus('recording');
    beginTimers();
  }, [fail, releaseAudio, transcribe, beginTimers]);

  // ── Shared interface ─────────────────────────────────────────────────────

  const start = useCallback(async () => {
    if (status !== 'idle') return;
    if (!isVoiceCaptureSupported()) { fail('Voice input is not supported on this device.'); return; }

    setError('');
    setElapsedMs(0);
    setInterimText('');
    interimRef.current = '';
    levelRef.current = 0;
    setStatus('starting');
    cancelledRef.current = false;
    stopReasonRef.current = 'user';

    if (isNativeSpeechPlatform()) {
      const handled = await startLive().catch(() => false);
      if (handled) return;
    }

    modeRef.current = 'upload';
    await startUpload();
  }, [status, fail, startLive, startUpload]);

  // `reason` is `user` for a tap, `limit` for the one-minute cap, and
  // `background` when the page finds a live recording the phone already ended.
  const finish = useCallback((reason) => {
    if (modeRef.current === 'live') { void stopLive(reason); return; }
    stopReasonRef.current = reason;
    if (recorderRef.current?.state === 'recording') {
      try { recorderRef.current.stop(); return; } catch { /* fall through */ }
    }
    cancelledRef.current = true;
    releaseAudio();
    setStatus('idle');
  }, [releaseAudio, stopLive]);

  const stop = useCallback(() => finish('user'), [finish]);

  useEffect(() => { stopRef.current = finish; }, [finish]);

  // iOS ends a live recording when the app leaves the screen, and its
  // finalResult normally arrives as the page wakes. If it went missing, asking
  // for the words here keeps the recording view from sitting on a dead meter.
  useEffect(() => {
    if (status !== 'recording' || mode !== 'live') return undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') stopRef.current?.('background');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [status, mode]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (modeRef.current === 'live') { cancelLive(); return; }
    if (recorderRef.current?.state === 'recording') {
      try { recorderRef.current.stop(); } catch { /* already stopped */ }
    }
    releaseAudio();
    setStatus('idle');
    setElapsedMs(0);
  }, [releaseAudio, cancelLive]);

  const clearError = useCallback(() => setError(''), []);

  return {
    status,
    error,
    elapsedMs,
    interimText,
    mode,
    analyserRef,
    levelRef,
    start,
    stop,
    cancel,
    clearError,
  };
}
