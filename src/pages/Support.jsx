import { Link, useNavigate } from 'react-router-dom';
import './Legal.css';

const SUPPORT_EMAIL = 'support@nightlink.dev';
const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;

// nightlink.dev/support. It opens for anyone, signed in or not, like the privacy
// and terms pages. Every step here is one the app really has, so when one of
// these flows changes, change this page with it.
export default function Support() {
  const navigate = useNavigate();
  return (
    <div className="page-container legal-page">
      <button type="button" className="page-back-btn" onClick={() => navigate(-1)}>
        Back
      </button>
      <article className="legal-card">
        <h1>Support</h1>

        <section>
          <h2>Write to us</h2>
          <p>
            Email <a href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a>, from the email on your Nightlink account if you
            can, so we can find it. Tell us:
          </p>
          <ul>
            <li>Your device, like an iPhone 16, and your browser if you use the website.</li>
            <li>
              The app version. On an iPhone, it&apos;s in the Settings app under General, then iPhone Storage,
              then Nightlink.
            </li>
            <li>What happened, and what you were trying to do. A screenshot helps.</li>
          </ul>
        </section>

        <section>
          <h2>Cancel or change Pro</h2>
          <p>
            <strong>Bought on an iPhone:</strong> open the Settings app, tap your name, then Subscriptions, then
            Nightlink. You can change or cancel your plan there. Cancel at least a day before the period ends
            so you aren&apos;t charged again.
          </p>
          <p>
            If Pro doesn&apos;t show up on a new iPhone, open Settings in Nightlink and tap Restore purchases.
          </p>
          <p>
            <strong>Bought on nightlink.dev:</strong> the website has no cancel button, so write to{' '}
            <a href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a> from the email on your account and ask us to cancel it.
          </p>
          <p>Deleting your account doesn&apos;t cancel a plan, so cancel it first.</p>
        </section>

        <section>
          <h2>Delete your account</h2>
          <p>
            In Nightlink, go to your profile and tap the gear to open Settings. At the bottom, tap More Options,
            then Delete account permanently. Type DELETE and tap Delete account. Your account, profile, dreams
            and comments are deleted right away, and this can&apos;t be undone.
          </p>
        </section>

        <section>
          <h2>Report a person or a post</h2>
          <ul>
            <li>A dream: tap the three dots on it, then Report.</li>
            <li>A comment: tap Report under it.</li>
            <li>A person: open their profile, tap the three dots, then Report user. Block user is in the same menu.</li>
          </ul>
        </section>

        <section>
          <h2>Privacy and terms</h2>
          <p>
            Read the <Link to="/privacy">Privacy Policy</Link> and the <Link to="/terms">Terms of Use</Link>.
          </p>
        </section>
      </article>
    </div>
  );
}
