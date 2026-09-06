import { useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import './TermsGate.css';

// Bump TERMS_VERSION whenever the Terms or Privacy Policy are updated.
// Users whose stored version doesn't match will be shown the gate again.
export const TERMS_VERSION = 'v3';
export const TERMS_KEY = `nightlink_terms_${TERMS_VERSION}`;

// localStorage throws outright in some privacy modes. Failing closed here just
// re-shows the gate; App.jsx restores acceptance from the user's profile.
export function isTermsAccepted() {
  try {
    return localStorage.getItem(TERMS_KEY) === '1';
  } catch {
    return false;
  }
}

export function markTermsAccepted() {
  try {
    localStorage.setItem(TERMS_KEY, '1');
  } catch {
    // Acceptance is also written to the profile, so this is recoverable.
  }
}

export default function TermsGate({ onAccepted }) {
  const [confirmedAge, setConfirmedAge] = useState(false);
  const [acceptedPolicies, setAcceptedPolicies] = useState(false);

  const canContinue = confirmedAge && acceptedPolicies;

  return (
    <div className="terms-gate">
      <div className="terms-gate-card">
        <div className="terms-gate-icon" aria-hidden="true">
          <img src="/favicon.svg" alt="" />
        </div>
        <h1 className="terms-gate-title">Before you continue</h1>
        <p className="terms-gate-desc">
          Please confirm the following to use Nightlink.
        </p>

        <div className="terms-gate-checks">
          <label className="terms-gate-check">
            <input
              type="checkbox"
              checked={confirmedAge}
              onChange={(e) => setConfirmedAge(e.target.checked)}
            />
            <span>I confirm I am 18 years of age or older.</span>
          </label>
          <label className="terms-gate-check">
            <input
              type="checkbox"
              checked={acceptedPolicies}
              onChange={(e) => setAcceptedPolicies(e.target.checked)}
            />
            <span>
              I agree to the <Link to="/terms">Terms of Use</Link> and{' '}
              <Link to="/privacy">Privacy Policy</Link>, and understand there is
              zero tolerance for abusive or objectionable content.
            </span>
          </label>
        </div>

        <button
          type="button"
          className="primary-btn terms-gate-btn"
          onClick={() => { markTermsAccepted(); onAccepted(); }}
          disabled={!canContinue}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

TermsGate.propTypes = {
  onAccepted: PropTypes.func.isRequired,
};
