import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBook, faWandMagicSparkles, faUserGroup,
  faEye, faLightbulb, faShieldHalved, faSliders,
} from '@fortawesome/free-solid-svg-icons';
import './HomePage.css';

// One icon per claim, no more. The page is a first impression for people who
// may not think of dreamwork as a software category, and a wall of symbols
// reads as occult shorthand rather than as a product.
const FEATURES = [
  {
    icon: faBook,
    title: 'Journal with intention',
    body: 'Write, tag, and organize dreams in a focused space designed for nightly reflection.',
  },
  {
    icon: faWandMagicSparkles,
    title: 'AI insight styles',
    body: 'Choose from grounded, mystical, and astrology-style interpretations that match your vibe.',
  },
  {
    icon: faUserGroup,
    title: 'Optional social sharing',
    body: 'Keep dreams private by default, or share selected entries with your community.',
  },
];

const PRIVACY_POINTS = [
  { icon: faEye, text: 'Dream visibility controls on every entry' },
  { icon: faLightbulb, text: 'AI summaries for reflection only' },
  { icon: faShieldHalved, text: 'No AI model training on your dream content' },
  { icon: faSliders, text: 'Account and policy controls in-app at any time' },
];

export default function HomePage() {
  useEffect(() => {
    document.documentElement.classList.add('no-overscroll');
    return () => document.documentElement.classList.remove('no-overscroll');
  }, []);

  return (
    <div className="home-page">
      <section className="home-hero">
        <div className="home-logo-row">
          <img src="/favicon.svg" alt="Nightlink" className="home-logo-icon" />
          <span className="home-logo-text">Nightlink</span>
        </div>
        <h1>Your private space for dream reflection and trusted connection.</h1>
        <p className="home-subtitle">
          Capture dreams, unlock AI-powered insights, and share only when you choose.
          Built with privacy-first controls so your dreams stay sacred.
        </p>
        <div className="home-cta-row">
          <Link to="/login?mode=signup" className="home-cta-primary">Create account</Link>
          <Link to="/login" className="home-cta-secondary">Sign in</Link>
        </div>
      </section>

      <section className="home-section">
        <h2>What you can do</h2>
        <div className="home-feature-grid">
          {FEATURES.map((feature, index) => (
            <article
              className="home-feature-card"
              key={feature.title}
              style={{ '--card-index': index }}
            >
              <span className="home-feature-icon" aria-hidden="true">
                <FontAwesomeIcon icon={feature.icon} />
              </span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="home-section home-security">
        <h2>Privacy by design</h2>
        <ul>
          {PRIVACY_POINTS.map((point) => (
            <li key={point.text}>
              <FontAwesomeIcon icon={point.icon} aria-hidden="true" />
              <span>{point.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="home-footer">
        <Link to="/terms">Terms of Use</Link>
        <span aria-hidden="true">•</span>
        <Link to="/privacy">Privacy Policy</Link>
        <span aria-hidden="true">•</span>
        <Link to="/support">Support</Link>
      </footer>
    </div>
  );
}
