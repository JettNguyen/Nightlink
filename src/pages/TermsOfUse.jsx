import { useNavigate } from 'react-router-dom';
import './Legal.css';

export default function TermsOfUse() {
  const navigate = useNavigate();
  return (
    <div className="page-container legal-page">
      <button type="button" className="legal-back-btn" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <article className="legal-card">
        <h1>Terms of Use</h1>
        <p className="legal-updated">Last updated: September 6, 2026</p>

        <section>
          <h2>1. Acceptance</h2>
          <p>
            By using Nightlink, you agree to these terms. If you do not agree, do not use the service.
            These terms are an agreement between you and Jett Nguyen, an individual developer based in
            Florida, United States, who operates Nightlink (&quot;we&quot;, &quot;us&quot;).
          </p>
        </section>

        <section>
          <h2>2. Eligibility and age requirement</h2>
          <p>
            You must be at least 18 years of age to create an account or use Nightlink. By creating an account,
            you confirm that you meet this requirement. Users under 18 are not permitted to use the service.
          </p>
          <p>
            You also confirm that you are not located in a country subject to a United States government
            embargo, and that you are not on any United States government list of prohibited or restricted
            parties.
          </p>
        </section>

        <section>
          <h2>3. Accounts and access</h2>
          <p>
            You are responsible for your account credentials and activity under your account. Keep your login
            details secure. We grant you a personal, non-transferable, non-exclusive licence to use Nightlink
            on Apple devices that you own or control, as permitted by the App Store Terms of Service.
          </p>
        </section>

        <section>
          <h2>4. Your content</h2>
          <p>
            Your dreams are yours. You keep ownership of everything you write, record, or upload to Nightlink.
          </p>
          <p>
            To run the service, you grant us a worldwide, non-exclusive, royalty-free licence to host, store,
            reproduce, and display your content, and to send it to the providers listed in our Privacy
            Policy, solely so that we can operate and improve Nightlink for you. If you choose to share a
            dream publicly, that licence extends to displaying it to other users through the feed, profiles,
            and search. This licence ends when you delete the content or your account, except for copies that
            remain in routine backups for a short period.
          </p>
          <p>
            You are responsible for what you post. You confirm you have the rights to it and that it does not
            infringe anyone else&apos;s rights.
          </p>
        </section>

        <section>
          <h2>5. AI insights and limitations</h2>
          <p>
            AI insights are informational only and are not medical, psychiatric, legal, or professional advice.
            AI output is generated automatically and may be inaccurate, incomplete, or unexpected. Do not rely
            on it as fact. Do not rely on Nightlink for emergency or crisis support. If you are in crisis,
            contact your local emergency services.
          </p>
        </section>

        <section>
          <h2>6. Billing and subscriptions</h2>
          <p>
            Purchases made inside the iOS app are processed by Apple through your Apple Account, and are also
            governed by Apple&apos;s terms. Purchases made on the Nightlink website are processed by Stripe.
            Pricing, subscription length, and renewal terms are shown before you confirm any purchase.
          </p>
          <p>
            Subscriptions renew automatically at the end of each period unless you cancel at least 24 hours
            before it ends. You can manage or cancel a subscription in the Subscriptions section of your Apple
            Account settings. Deleting the app does not cancel it. Payment is charged to your Apple Account at
            confirmation of purchase, and again at each renewal.
          </p>
          <p>
            Refunds for purchases made through the App Store are handled by Apple under its own refund policy,
            not by us. Credits and premium features may change over time.
          </p>
        </section>

        <section>
          <h2>7. Acceptable use</h2>
          <ul>
            <li>Do not use Nightlink for unlawful, abusive, or fraudulent activity.</li>
            <li>Do not attempt to disrupt, reverse engineer, or exploit the service.</li>
            <li>Do not upload content that violates others&apos; rights.</li>
            <li>Nightlink has zero tolerance for objectionable content, harassment, and abusive users.</li>
            <li>We may remove violating content and restrict or terminate accounts that break these rules.</li>
            <li>Safety reports are reviewed within 24 hours, and confirmed violations are removed promptly.</li>
          </ul>
          <p>
            Every dream, comment, and profile can be reported from the app, and you can block any user from
            their profile, which removes their content from your feed and stops them contacting you. Reports
            reach us directly and we act on them without waiting for a pattern to form.
          </p>
        </section>

        <section>
          <h2>8. Copyright complaints</h2>
          <p>
            If you believe content on Nightlink infringes your copyright, email us at jettuf26@gmail.com with
            a description of the work, a link to the content, your contact details, and a statement that you
            hold the rights or act for the person who does. We remove infringing content and terminate accounts
            of repeat infringers.
          </p>
        </section>

        <section>
          <h2>9. How Nightlink is built</h2>
          <p>
            AI tools were used in the development of this app, including to help write, review, and test parts
            of its source code, and to help draft written material such as these policies. Every change is
            reviewed by a human before it ships, and we remain responsible for the app and everything in it.
          </p>
          <p>
            This is separate from the AI features you use inside Nightlink. The tools used to build the app
            work on our source code and have no access to your account, your dreams, or any other user data.
          </p>
        </section>

        <section>
          <h2>10. Disclaimer of warranties</h2>
          <p>
            Nightlink is provided &quot;as is&quot; and &quot;as available&quot;, without warranties of any
            kind, whether express or implied, including any implied warranty of merchantability, fitness for a
            particular purpose, or non-infringement. We do not warrant that the service will be uninterrupted,
            error-free, or secure, or that your content will always be preserved, so please keep your own copies
            of anything you cannot afford to lose. Some jurisdictions do not allow the exclusion of implied
            warranties, so parts of this section may not apply to you.
          </p>
        </section>

        <section>
          <h2>11. Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, we are not liable for any indirect, incidental, special,
            consequential, or punitive damages, or for any loss of data, profits, or goodwill, arising out of
            your use of Nightlink. Our total liability for any claim relating to the service is limited to the
            greater of the amount you paid us in the twelve months before the claim, or fifty United States
            dollars. Nothing in these terms excludes liability that cannot be excluded by law.
          </p>
        </section>

        <section>
          <h2>12. Indemnity</h2>
          <p>
            You agree to indemnify and hold us harmless from any claim, loss, or demand, including reasonable
            legal fees, brought by a third party and arising out of the content you post or your breach of
            these terms.
          </p>
        </section>

        <section>
          <h2>13. Termination</h2>
          <p>
            Nightlink may suspend or terminate access for violations of these terms. You can delete your account
            from Settings at any time. Sections 4, 10, 11, 12, and 14 survive termination.
          </p>
        </section>

        <section>
          <h2>14. Governing law and disputes</h2>
          <p>
            These terms are governed by the laws of the State of Florida, United States, without regard to its
            conflict of law rules. You and we agree that any dispute will be brought exclusively in the state
            or federal courts located in Florida, and we each consent to their jurisdiction. If you are a
            consumer resident in the European Economic Area or the United Kingdom, nothing here deprives you of
            the protection of the mandatory laws of the country where you live, or of your right to bring a
            claim in your local courts.
          </p>
        </section>

        <section>
          <h2>15. Apple</h2>
          <p>
            This agreement is between you and us only, not with Apple, and we alone are responsible for
            Nightlink and its content. Apple has no obligation to provide any maintenance or support for
            Nightlink. If Nightlink fails to conform to any applicable warranty, you may notify Apple and Apple
            will refund the purchase price, if any; to the maximum extent permitted by law, Apple has no other
            warranty obligation with respect to Nightlink. We, not Apple, are responsible for addressing any
            claim relating to Nightlink, including product liability claims, claims that it fails to conform to
            a legal requirement, and claims arising under consumer protection or similar legislation. We, not
            Apple, are responsible for investigating and resolving any third-party claim that Nightlink
            infringes that party&apos;s intellectual property rights. Apple and its subsidiaries are
            third-party beneficiaries of these terms and may enforce them against you.
          </p>
        </section>

        <section>
          <h2>16. Changes to these terms</h2>
          <p>
            We may update these terms as Nightlink changes. When we do, we will revise the date at the top of
            this page, and for material changes we will ask you to review and accept the updated terms the next
            time you open the app. Continuing to use Nightlink after that means you accept them.
          </p>
        </section>

        <section>
          <h2>17. General</h2>
          <p>
            If any part of these terms is found unenforceable, the rest stays in force. Our not enforcing a
            provision is not a waiver of it. You may not transfer your rights under these terms; we may
            transfer ours to a successor if Nightlink changes hands. These terms and the Privacy Policy are the
            entire agreement between you and us about the service.
          </p>
        </section>

        <section>
          <h2>18. Contact</h2>
          <p>
            For policy and safety reports, contact Jett Nguyen at jettuf26@gmail.com.
          </p>
        </section>
      </article>
    </div>
  );
}
