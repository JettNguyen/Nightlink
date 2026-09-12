import { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMicrophone, faStop, faXmark } from '@fortawesome/free-solid-svg-icons';
import useVoiceCapture, { isVoiceCaptureSupported, MAX_RECORDING_MS } from '../hooks/useVoiceCapture';
import { triggerLightHaptic, triggerMediumHaptic } from '../utils/haptics';
import './VoiceInput.css';

const BAR_COUNT = 24;
const SUPPORTED = isVoiceCaptureSupported();

// Past this, a press reads as push-to-talk and letting go ends the recording.
// Under it, the press is a tap and the recording stays open until the next one.
const HOLD_MS = 400;
// How often the live meter takes a sample. 24 bars at this rate is a rolling
// window of about a second and a half, which scrolls at a readable pace.
const SAMPLE_MS = 55;
const HINT_KEY = 'nightlink:voice-hint-seen';

const formatClock = (ms) => {
  const total = Math.floor(ms / 1000);
  return `0:${String(Math.min(total, 99)).padStart(2, '0')}`;
};

const readHintSeen = () => {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return true; }
};

/**
 * Mic button that dictates into a text field.
 *
 * The waveform is driven straight from the audio layer inside a rAF loop and
 * written to the bars as inline transforms, keeping 60fps amplitude out of
 * React state, which would otherwise re-render the whole composer every frame.
 * The two capture engines feed it differently: the upload path has a Web Audio
 * analyser to read a spectrum from, while the native path can only hand back a
 * single amplitude per buffer, so that one scrolls as a history instead.
 */
export default function VoiceInput({ onTranscript, onNotice, disabled, label }) {
  const barsRef = useRef(null);
  const frameRef = useRef(null);
  const levelsRef = useRef(new Float32Array(BAR_COUNT));
  const historyRef = useRef(new Float32Array(BAR_COUNT));
  const lastSampleRef = useRef(0);
  const captionRef = useRef(null);

  const [hintSeen, setHintSeen] = useState(readHintSeen);

  const dismissHint = useCallback(() => {
    setHintSeen((seen) => {
      if (seen) return seen;
      try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode */ }
      return true;
    });
  }, []);

  const handleTranscript = useCallback((text) => {
    void triggerMediumHaptic();
    onTranscript(text);
  }, [onTranscript]);

  const handleError = useCallback((message) => {
    onNotice?.(message);
  }, [onNotice]);

  const {
    status, elapsedMs, interimText, mode, analyserRef, levelRef, start, stop, cancel,
  } = useVoiceCapture({
    onTranscript: handleTranscript,
    onError: handleError,
  });

  const isRecording = status === 'recording';
  const isBusy = status === 'starting' || status === 'transcribing';
  const isLive = mode === 'live';

  // Press-and-hold bookkeeping. People reach for a mic button expecting a
  // walkie-talkie, so a hold that is released has to end the recording, but a
  // quick tap still has to leave it running, or one-handed use is impossible.
  const pressStartedAtRef = useRef(0);
  const pressOpenedRecordingRef = useRef(false);
  const stopWhenReadyRef = useRef(false);

  // Paint the bars from live amplitude for as long as we are recording.
  useEffect(() => {
    if (!isRecording) {
      if (frameRef.current) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
      const bars = barsRef.current?.children;
      if (bars) {
        for (let i = 0; i < bars.length; i += 1) bars[i].style.transform = 'scaleY(0.08)';
      }
      levelsRef.current.fill(0);
      historyRef.current.fill(0);
      return undefined;
    }

    const spectrum = new Uint8Array(analyserRef.current?.frequencyBinCount || BAR_COUNT);

    const paintHistory = (bars) => {
      const now = performance.now();
      const history = historyRef.current;
      if (now - lastSampleRef.current >= SAMPLE_MS) {
        lastSampleRef.current = now;
        history.copyWithin(0, 1);
        history[BAR_COUNT - 1] = levelRef.current || 0;
      }
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const bar = bars[i];
        if (!bar) continue;
        const scale = Math.max(0.08, Math.min(1, history[i] * 1.15));
        bar.style.transform = `scaleY(${scale.toFixed(3)})`;
      }
    };

    const paintSpectrum = (bars) => {
      const analyser = analyserRef.current;
      if (analyser) analyser.getByteFrequencyData(spectrum);

      // Speech lives in the lower bins, so sample the bottom ~60% of the
      // spectrum and mirror it outward from the centre.
      const usable = Math.max(1, Math.floor(spectrum.length * 0.6));
      const half = Math.ceil(BAR_COUNT / 2);

      for (let i = 0; i < half; i += 1) {
        const bin = Math.floor((i / half) * usable);
        const raw = analyser ? spectrum[bin] / 255 : 0;
        // Ease upward fast and fall away slowly, which reads as speech, not noise.
        const previous = levelsRef.current[i];
        const next = raw > previous ? raw : previous * 0.82 + raw * 0.18;
        levelsRef.current[i] = next;

        const scale = Math.max(0.08, Math.min(1, next * 1.35));
        const left = bars[half - 1 - i];
        const right = bars[half + i];
        if (left) left.style.transform = `scaleY(${scale.toFixed(3)})`;
        if (right) right.style.transform = `scaleY(${scale.toFixed(3)})`;
      }
    };

    const paint = () => {
      frameRef.current = requestAnimationFrame(paint);
      const bars = barsRef.current?.children;
      if (!bars) return;
      if (isLive) paintHistory(bars);
      else paintSpectrum(bars);
    };

    frameRef.current = requestAnimationFrame(paint);
    return () => {
      if (frameRef.current) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
    };
  }, [isRecording, isLive, analyserRef, levelRef]);

  // Keep the newest words in view as they stream in.
  useEffect(() => {
    const node = captionRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [interimText]);

  // A hold released while the recording was still opening still has to end it,
  // so the release is remembered and applied the moment it is actually live.
  useEffect(() => {
    if (!stopWhenReadyRef.current) return;
    if (isRecording) {
      stopWhenReadyRef.current = false;
      void triggerLightHaptic();
      stop();
    } else if (status === 'idle') {
      // The start never made it. Drop the pending release, or it would cut the
      // next recording short the moment it opens.
      stopWhenReadyRef.current = false;
    }
  }, [isRecording, status, stop]);

  if (!SUPPORTED) return null;

  const beginPress = (event) => {
    if (event.button != null && event.button > 0) return;
    if (disabled || isBusy) return;
    // Without capture, sliding a finger off the button swallows the pointerup
    // and a push-to-talk hold would never end.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
    pressStartedAtRef.current = Date.now();
    void triggerLightHaptic();
    if (isRecording) {
      pressOpenedRecordingRef.current = false;
      stop();
    } else {
      pressOpenedRecordingRef.current = true;
      dismissHint();
      void start();
    }
  };

  const endPress = () => {
    const opened = pressOpenedRecordingRef.current;
    pressOpenedRecordingRef.current = false;
    if (!opened) return;
    if (Date.now() - pressStartedAtRef.current < HOLD_MS) return;
    // Held down like a walkie-talkie, so releasing sends it.
    if (isRecording) {
      void triggerLightHaptic();
      stop();
    } else {
      stopWhenReadyRef.current = true;
    }
  };

  // Pointer events do not fire for Enter/Space on a focused button, and a
  // keyboard-driven click reports a detail of 0, so this handles only those.
  const handleKeyboardClick = (event) => {
    if (event.detail !== 0) return;
    if (disabled || isBusy) return;
    void triggerLightHaptic();
    if (isRecording) stop();
    else { dismissHint(); void start(); }
  };

  const remaining = Math.max(0, MAX_RECORDING_MS - elapsedMs);
  const runningOut = isRecording && remaining <= 10_000;
  const showHint = !hintSeen && !isRecording && !isBusy && !disabled;

  return (
    <div className={`voice-input${isRecording ? ' is-recording' : ''}${isLive ? ' is-live' : ''}`}>
      {isRecording && (
        <div className="voice-caption" role="status" aria-live="polite">
          <div className="voice-caption-text" ref={captionRef}>
            {isLive && interimText
              ? interimText
              : <span className="voice-caption-idle">Listening…</span>}
          </div>
          <p className="voice-caption-hint">Tap the stop button when you are done</p>
        </div>
      )}

      {showHint && (
        <span className="voice-hint" aria-hidden="true">Tap to speak</span>
      )}

      {isRecording && (
        <div className="voice-input-live">
          <button
            type="button"
            className="voice-input-cancel"
            onClick={() => { void triggerLightHaptic(); cancel(); }}
            aria-label="Discard recording"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
          <div className="voice-wave" ref={barsRef} aria-hidden="true">
            {Array.from({ length: BAR_COUNT }, (_, i) => (
              <span key={i} className="voice-wave-bar" />
            ))}
          </div>
          <span className={`voice-input-clock${runningOut ? ' is-ending' : ''}`}>
            {formatClock(elapsedMs)}
          </span>
        </div>
      )}

      {/* Deliberately not disabled while starting: a disabled button stops firing
          pointerup, which would strand a hold released during the moment the
          recogniser takes to spin up. */}
      <button
        type="button"
        className={`voice-input-btn${isRecording ? ' is-recording' : ''}${isBusy ? ' is-busy' : ''}`}
        onPointerDown={beginPress}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onClick={handleKeyboardClick}
        onContextMenu={(e) => e.preventDefault()}
        disabled={disabled || status === 'transcribing'}
        aria-label={isRecording ? 'Stop recording' : `${label}. Tap to start, tap again to stop.`}
        aria-live="polite"
      >
        {status === 'transcribing' ? (
          <span className="voice-input-spinner" aria-hidden="true" />
        ) : (
          <FontAwesomeIcon icon={isRecording ? faStop : faMicrophone} />
        )}
        <span className="sr-only">
          {status === 'transcribing' ? 'Finishing your recording' : ''}
        </span>
      </button>
    </div>
  );
}

VoiceInput.propTypes = {
  onTranscript: PropTypes.func.isRequired,
  onNotice: PropTypes.func,
  disabled: PropTypes.bool,
  label: PropTypes.string,
};

VoiceInput.defaultProps = {
  onNotice: undefined,
  disabled: false,
  label: 'Dictate your dream',
};

/* The mic floats over the bottom right of the field, and the textarea reserves
   padding so the end of the text clears it. That padding only helps once the
   field is scrolled all the way down, and a browser scrolling the caret into
   view stops as soon as the caret is inside the visible box, which leaves the
   line you are typing sitting underneath the button.
   
   Pinning the scroll to the bottom while the caret is at the end of the value
   reveals that reserved padding, so the live line stays above the mic. Editing
   anywhere else in the text is left alone. */
export function VoiceField({ children, className }) {
  const rootRef = useRef(null);

  useEffect(() => {
    const field = rootRef.current?.querySelector('textarea');
    if (!field) return undefined;
    const keepCaretClear = () => {
      if (field.selectionStart !== field.value.length) return;
      field.scrollTop = field.scrollHeight;
    };
    field.addEventListener('input', keepCaretClear);
    return () => field.removeEventListener('input', keepCaretClear);
  }, []);

  return (
    <div ref={rootRef} className={className ? `voice-field ${className}` : 'voice-field'}>
      {children}
    </div>
  );
}

VoiceField.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string,
};

VoiceField.defaultProps = {
  children: null,
  className: '',
};
