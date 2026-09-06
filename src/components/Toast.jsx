import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import './Toast.css';

// Must match the toastOut duration in Toast.css.
const EXIT_MS = 180;

export default function Toast({ message, onDismiss, duration = 3000 }) {
  // The toast used to unmount the moment `message` cleared, so it had no chance
  // to animate out, so it just blinked off. It keeps rendering the last message
  // through the exit animation instead.
  const [shown, setShown] = useState({ text: message || '', phase: message ? 'in' : 'hidden' });

  useEffect(() => {
    if (message) {
      setShown({ text: message, phase: 'in' });
    } else {
      setShown((prev) => (prev.phase === 'hidden' ? prev : { ...prev, phase: 'out' }));
    }
  }, [message]);

  useEffect(() => {
    if (shown.phase !== 'out') return undefined;
    const t = setTimeout(() => setShown({ text: '', phase: 'hidden' }), EXIT_MS);
    return () => clearTimeout(t);
  }, [shown.phase]);

  useEffect(() => {
    if (!message) return undefined;
    const t = setTimeout(onDismiss, duration);
    return () => clearTimeout(t);
  }, [message, onDismiss, duration]);

  if (shown.phase === 'hidden' || !shown.text) return null;

  return (
    <div
      className={`toast${shown.phase === 'out' ? ' is-leaving' : ''}`}
      role="status"
      aria-live="polite"
      onClick={onDismiss}
    >
      {shown.text}
    </div>
  );
}

Toast.propTypes = {
  message: PropTypes.string,
  onDismiss: PropTypes.func.isRequired,
  duration: PropTypes.number,
};
