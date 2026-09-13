import { useNavigate } from 'react-router-dom';
import './Legal.css';

export default function PrivacyPolicy() {
  const navigate = useNavigate();
  return (
    <div className="page-container legal-page">
      <button type="button" className="page-back-btn" onClick={() => navigate(-1)}>
        Back
      </button>
      <article className="legal-card">
        <h1>Privacy Policy</h1>
        <p className="legal-updated">Last updated: September 6, 2026</p>

        <section>
          <h2>1. Who we are</h2>
          <p>
            Nightlink is operated by Jett Nguyen, an individual developer based in Florida, United States
            (&quot;we&quot;, &quot;us&quot;). For the purposes of the EU and UK General Data Protection
            Regulation, we are the data controller for the personal data described below. You can reach us
            at any time at jettuf26@gmail.com.
          </p>
        </section>

        <section>
          <h2>2. Data we collect</h2>
          <ul>
            <li>Contact info: name (display name) and email address.</li>
            <li>Identifiers: account and profile identifiers (for example user ID and username).</li>
            <li>User content: dreams, comments, reactions, and related activity content.</li>
            <li>
              Voice recordings: if you dictate a dream, audio captured from your microphone. Where your
              device supports on-device recognition, the audio never leaves your phone. Otherwise the
              recording is sent to our transcription provider, converted to text, and discarded.
            </li>
            <li>Safety reports you submit (for example report reason, target content ID, and timestamp).</li>
            <li>Search history: search terms you enter inside Nightlink.</li>
            <li>Device identifiers used for notifications (for example push notification tokens on supported devices).</li>
            <li>Purchases and subscription status (for example premium entitlement and credit balance).</li>
            <li>Product interaction data needed to operate app features (for example read state and feed seen state).</li>
            <li>
              Limited technical data our hosting and error handling produce automatically, such as IP address,
              request timestamps, and crash or error diagnostics.
            </li>
          </ul>
          <p>
            Nightlink also stores small amounts of data locally on your device (for example your session,
            your acceptance of these policies, and drafts) so the app works between launches. This stays on
            your device and is cleared when you sign out or delete the app.
          </p>
        </section>

        <section>
          <h2>3. How we use data</h2>
          <ul>
            <li>Provide core features such as journaling, social activity, notifications, and AI insights.</li>
            <li>Authenticate accounts and keep profiles in sync.</li>
            <li>Process and manage in-app purchases and subscription state.</li>
            <li>Protect the app, prevent abuse, and maintain reliability.</li>
            <li>Review and action safety reports, including removing violating content and restricting abusive users.</li>
            <li>Comply with legal obligations and respond to lawful requests.</li>
          </ul>
        </section>

        <section>
          <h2>4. Legal bases for processing</h2>
          <p>
            If you are in the European Economic Area or the United Kingdom, we rely on the following legal
            bases under Article 6 of the GDPR:
          </p>
          <ul>
            <li>
              <strong>Performance of a contract:</strong> to give you the account, journal, social features,
              and purchases you signed up for.
            </li>
            <li>
              <strong>Legitimate interests:</strong> to keep the service secure, prevent abuse, review safety
              reports, and fix errors, balanced against your rights.
            </li>
            <li>
              <strong>Consent:</strong> for microphone access and push notifications, which your device asks
              you to grant and which you can withdraw at any time in iOS Settings.
            </li>
            <li>
              <strong>Legal obligation:</strong> where we are required to retain or disclose data by law.
            </li>
          </ul>
        </section>

        <section>
          <h2>5. AI processing</h2>
          <p>
            Dream text you submit for AI insights is sent to OpenAI, our AI service provider, to generate
            titles, summaries, and reflections. Voice recordings that cannot be transcribed on your device are
            sent to the same provider and converted to text.
          </p>
          <p>
            This processing happens through OpenAI&apos;s business API, under terms that prohibit using your
            content to train their models. We do not use your dreams, comments, or recordings to train any AI
            model of our own, and we do not sell or license your content to anyone for that purpose.
          </p>
          <p>
            AI output can be wrong, incomplete, or unexpected. Insights are informational only and are not
            medical, psychiatric, or professional advice. Please do not include highly sensitive personal
            information in text you submit for analysis, whether it concerns you or someone else.
          </p>
          <p>
            AI tools were also used to help write and review the software that runs Nightlink. Those
            development tools operate on our source code, not on your account or your dream content, and had
            no access to user data. See section 9 of the Terms of Use for more detail.
          </p>
        </section>

        <section>
          <h2>6. Service providers and data sharing</h2>
          <p>
            Nightlink uses third-party service providers to operate the app:
          </p>
          <ul>
            <li><strong>Supabase:</strong> authentication, database, and file storage.</li>
            <li><strong>Vercel:</strong> hosting for the website and backend endpoints.</li>
            <li><strong>OpenAI:</strong> AI insight generation and speech transcription.</li>
            <li><strong>RevenueCat and Apple:</strong> in-app purchase and subscription entitlement processing.</li>
            <li><strong>Stripe:</strong> payment processing for purchases made on the web.</li>
            <li><strong>Apple Push Notification service</strong> and our notification delivery provider, for sending push notifications.</li>
          </ul>
          <p>
            These providers process data only on our instructions and only as needed to run the app. We also
            disclose data where we are legally required to, or where it is necessary to investigate abuse or
            protect the safety of our users.
          </p>
          <p>
            We do not sell your personal information, and we do not share it for cross-context behavioural
            advertising.
          </p>
        </section>

        <section>
          <h2>7. International data transfers</h2>
          <p>
            Nightlink is operated from the United States, and our providers store and process data in the
            United States. If you use Nightlink from outside the United States, your personal data is
            transferred there. Where data is transferred out of the European Economic Area or the United
            Kingdom, that transfer relies on the European Commission&apos;s Standard Contractual Clauses, or the
            UK International Data Transfer Addendum, as incorporated into our agreements with each provider.
          </p>
        </section>

        <section>
          <h2>8. Tracking and advertising</h2>
          <p>
            Nightlink does not use collected data for third-party advertising or data broker sharing, does not
            track you across other companies&apos; apps and websites, and contains no advertising SDKs. If this
            changes in a future version, this policy will be updated before release.
          </p>
        </section>

        <section>
          <h2>9. Retention and deletion</h2>
          <p>
            We keep your account data for as long as your account exists. You can permanently delete your
            account at any time from Settings, which removes your profile, dreams, comments, reactions, and
            associated app data from the live Nightlink database immediately. Residual copies in encrypted
            backups are overwritten in the normal backup cycle within 30 days.
          </p>
          <p>
            Two exceptions: safety reports and records of enforcement action are kept for up to 12 months so
            that we can recognise repeat abuse, and purchase records are kept for as long as tax and
            accounting law requires. Voice recordings sent for transcription are not retained after the text
            is returned.
          </p>
        </section>

        <section>
          <h2>10. Security</h2>
          <p>
            Data is encrypted in transit, access to production systems is restricted, and database access
            rules limit each account to its own data. No service can promise perfect security, but if a breach
            affects your personal data we will notify you and the relevant regulator where the law requires it.
          </p>
        </section>

        <section>
          <h2>11. Age requirement and minors</h2>
          <p>
            Nightlink is intended for users who are 18 years of age or older. We do not knowingly collect
            personal information from anyone under 18. If you believe someone under 18 has created an
            account, please contact us and we will promptly remove the account and associated data.
          </p>
        </section>

        <section>
          <h2>12. Your rights</h2>
          <p>
            Depending on where you live, you may have the right to access the personal data we hold about you,
            correct it, delete it, receive a portable copy, object to or restrict certain processing, and
            withdraw consent you have given. Most of these you can exercise directly in the app: your profile
            is editable in Settings, and account deletion is immediate. For anything else, email us and we
            will respond within 30 days.
          </p>
          <p>
            <strong>EEA and UK residents.</strong> You also have the right to lodge a complaint with your local
            supervisory authority. Withdrawing consent does not affect processing carried out before you
            withdrew it.
          </p>
          <p>
            <strong>California residents.</strong> Under the CCPA and CPRA you have the right to know what
            categories of personal information we collect and disclose (listed in sections 2 and 6 above), to
            request deletion or correction, to opt out of sale or sharing, and not to be discriminated against
            for exercising any of these rights. As stated above, we do not sell or share personal information,
            so there is nothing to opt out of.
          </p>
        </section>

        <section>
          <h2>13. Changes to this policy</h2>
          <p>
            We may update this policy as Nightlink changes. When we do, we will revise the date at the top of
            this page, and for material changes we will ask you to review and accept the updated policy the
            next time you open the app.
          </p>
        </section>

        <section>
          <h2>14. Contact</h2>
          <p>
            For privacy or safety questions, contact Jett Nguyen at jettuf26@gmail.com.
          </p>
        </section>
      </article>
    </div>
  );
}
