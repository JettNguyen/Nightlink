import { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { useNavigate } from 'react-router-dom';
import Overlay from './Overlay';
import useEscapeKey from '../hooks/useEscapeKey';
import {
  getOfferings,
  purchasePackage,
  restorePurchases,
  isProFromCustomerInfo,
} from '../utils/purchases';
import { triggerErrorHaptic, triggerSelectionHaptic, triggerSuccessHaptic } from '../utils/haptics';
import './SkeletonLoader.css';
import './ProPlansSheet.css';

/**
 * Nightlink's own Pro plans screen. It replaced RevenueCat's paywall so the
 * screen looks like the rest of the app; RevenueCat still sells the plans.
 * Prices come from the App Store through the current offering, so a price
 * change in App Store Connect shows here without a release.
 */

const PERKS = [
  { title: '30 analyses a month', line: 'Free accounts get one.' },
  { title: 'Every analysis style', line: 'Mystic Oracle, Story Weaver, Movie Director and the rest.' },
  { title: 'Your own instructions', line: 'Tell the AI how you want your dreams read.' },
  { title: 'Dream memory', line: 'Each analysis remembers your recurring symbols, people and themes.' },
];

// How each kind of plan is named, how its price is read out, and the line
// under it. A kind not listed here falls back to the App Store's own title.
const PLAN_KINDS = {
  ANNUAL: { name: 'Yearly', per: 'a year', renews: true },
  SIX_MONTH: { name: 'Every 6 months', per: 'every 6 months', renews: true },
  THREE_MONTH: { name: 'Every 3 months', per: 'every 3 months', renews: true },
  TWO_MONTH: { name: 'Every 2 months', per: 'every 2 months', renews: true },
  MONTHLY: { name: 'Monthly', per: 'a month', renews: true },
  WEEKLY: { name: 'Weekly', per: 'a week', renews: true },
  LIFETIME: { name: 'Lifetime', per: '', renews: false },
};

const joinNames = (names) => (
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
);

/** The offering's packages as the rows this screen shows, in the offering's order. */
const plansFromOffering = (offering) => {
  const packages = offering?.availablePackages || [];
  const monthly = packages.find((pkg) => pkg.packageType === 'MONTHLY');

  return packages.map((pkg) => {
    const product = pkg.product || {};
    const kind = PLAN_KINDS[pkg.packageType];
    const renews = kind ? kind.renews : product.productCategory !== 'NON_SUBSCRIPTION';
    const plan = {
      id: pkg.identifier,
      pkg,
      name: kind?.name || product.title || 'Pro',
      price: product.priceString || '',
      per: kind?.per || '',
      renews,
      detail: renews ? 'Cancel any time' : 'One payment, no renewals',
      badge: '',
    };

    if (pkg.packageType === 'ANNUAL') {
      if (product.pricePerMonthString) plan.detail = `${product.pricePerMonthString} a month`;
      const fullYear = Number(monthly?.product?.price) * 12;
      const yearly = Number(product.price);
      if (fullYear > 0 && yearly > 0) {
        const saved = Math.round((1 - yearly / fullYear) * 100);
        if (saved >= 5) plan.badge = `Save ${saved}%`;
      }
    }
    return plan;
  });
};

const errorCode = (err) => String(err?.code ?? err?.data?.code ?? '');

const isCancel = (err) => (
  errorCode(err) === '1'
  || err?.userCancelled === true
  || err?.data?.userCancelled === true
  || /cancel/i.test(err?.message || '')
);

const purchaseErrorText = (err) => {
  switch (errorCode(err)) {
    case '20':
      return 'Waiting for approval. Pro turns on as soon as the purchase is approved.';
    case '6':
      return 'This Apple Account already has Pro. Tap Restore purchases to turn it on here.';
    case '10':
      return "Couldn't reach the App Store. Check your connection and try again.";
    case '3':
      return 'Purchases are turned off on this iPhone. You can allow them in Settings, under Screen Time.';
    default:
      return "The purchase didn't go through. Try again, and if it keeps failing, check your payment details in Settings, under your name.";
  }
};

function PlanSkeleton() {
  return (
    <div className="pro-plan sk" aria-hidden="true">
      <span className="pro-plan-radio" />
      <span className="pro-plan-text">
        <span className="sk-line pro-plan-name"><span className="sk-line-bar skel" style={{ width: '5.5em' }} /></span>
        <span className="sk-line pro-plan-detail"><span className="sk-line-bar skel" style={{ width: '7em' }} /></span>
      </span>
      <span className="sk-line pro-plan-price"><span className="sk-line-bar skel" style={{ width: '4.5em' }} /></span>
    </div>
  );
}

export default function ProPlansSheet({ onClose, onCustomerInfo }) {
  const navigate = useNavigate();
  const [plans, setPlans] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const loadPlans = useCallback(async () => {
    setLoadFailed(false);
    setPlans(null);
    try {
      const offerings = await getOfferings();
      const next = plansFromOffering(offerings?.current);
      if (!next.length) throw new Error('No plans in the current offering.');
      setPlans(next);
      setSelectedId((current) => (
        next.some((plan) => plan.id === current)
          ? current
          : (next.find((plan) => plan.pkg.packageType === 'ANNUAL') || next[0]).id
      ));
    } catch (err) {
      console.warn('Pro plans failed to load:', err?.message || err);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  const closeIfIdle = useCallback(() => {
    if (busy !== 'buy') onClose();
  }, [busy, onClose]);
  useEscapeKey(closeIfIdle);

  const selected = useMemo(
    () => plans?.find((plan) => plan.id === selectedId) || null,
    [plans, selectedId],
  );

  const renewingNames = useMemo(
    () => (plans || []).filter((plan) => plan.renews).map((plan) => plan.name),
    [plans],
  );

  const choose = (id) => {
    if (busy || id === selectedId) return;
    void triggerSelectionHaptic();
    setSelectedId(id);
    setMessage('');
  };

  const handleBuy = async () => {
    if (!selected || busy) return;
    setBusy('buy');
    setMessage('');
    try {
      const info = await purchasePackage(selected.pkg);
      if (isProFromCustomerInfo(info)) {
        void triggerSuccessHaptic();
        await onCustomerInfo(info, 'purchased');
        return;
      }
      await onCustomerInfo(info, 'purchased');
      setMessage("The App Store finished, but Pro hasn't turned on yet. Wait a minute, then tap Restore purchases.");
    } catch (err) {
      if (isCancel(err)) return;
      void triggerErrorHaptic();
      setMessage(purchaseErrorText(err));
    } finally {
      setBusy('');
    }
  };

  const handleRestore = async () => {
    if (busy) return;
    setBusy('restore');
    setMessage('');
    try {
      const info = await restorePurchases();
      await onCustomerInfo(info, 'restored');
      if (!isProFromCustomerInfo(info)) {
        setMessage('No Pro purchase was found on this Apple Account.');
      }
    } catch (err) {
      void triggerErrorHaptic();
      setMessage(errorCode(err) === '10'
        ? "Couldn't reach the App Store. Check your connection and try again."
        : "Restoring didn't work this time. Try again in a moment.");
    } finally {
      setBusy('');
    }
  };

  const openPage = (path) => {
    onClose();
    navigate(path);
  };

  const buyLabel = (() => {
    if (busy === 'buy') return 'Waiting for the App Store…';
    if (!selected) return 'Get Pro';
    return `Get Pro for ${selected.price}${selected.per ? ` ${selected.per}` : ''}`;
  })();

  return (
    <Overlay>
      <div className="pro-plans" role="dialog" aria-modal="true" aria-labelledby="pro-plans-title">
        <div className="pro-plans-bar">
          <button type="button" className="pro-plans-close" onClick={closeIfIdle} disabled={busy === 'buy'}>
            Close
          </button>
        </div>

        <div className="pro-plans-scroll">
          <div className="pro-plans-inner">
            <h1 id="pro-plans-title" className="pro-plans-title">Nightlink Pro</h1>
            <p className="pro-plans-lead">For when one analysis a month isn&apos;t enough.</p>

            <ul className="pro-perks">
              {PERKS.map((perk) => (
                <li key={perk.title} className="pro-perk">
                  <span className="pro-perk-check" aria-hidden="true" />
                  <span>
                    <span className="pro-perk-title">{perk.title}</span>
                    <span className="pro-perk-line">{perk.line}</span>
                  </span>
                </li>
              ))}
            </ul>

            {loadFailed ? (
              <div className="pro-plans-failed">
                <p>The plans didn&apos;t load. Check your connection, then try again.</p>
                <button type="button" className="secondary-btn" onClick={() => void loadPlans()}>
                  Try again
                </button>
              </div>
            ) : (
              <div className="pro-plan-list" role="radiogroup" aria-label="Plans">
                {plans
                  ? plans.map((plan) => {
                    const isSelected = plan.id === selectedId;
                    return (
                      <button
                        key={plan.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        className={`pro-plan${isSelected ? ' selected' : ''}`}
                        onClick={() => choose(plan.id)}
                        disabled={Boolean(busy) && !isSelected}
                      >
                        <span className="pro-plan-radio" aria-hidden="true" />
                        <span className="pro-plan-text">
                          <span className="pro-plan-name">
                            {plan.name}
                            {plan.badge && <span className="pro-plan-badge">{plan.badge}</span>}
                          </span>
                          <span className="pro-plan-detail">{plan.detail}</span>
                        </span>
                        <span className="pro-plan-price">
                          {plan.price}
                          {plan.per && <span className="pro-plan-per"> {plan.per}</span>}
                        </span>
                      </button>
                    );
                  })
                  : [0, 1, 2].map((key) => <PlanSkeleton key={key} />)}
              </div>
            )}
          </div>
        </div>

        <div className="pro-plans-footer">
          <div className="pro-plans-inner">
            {message && <p className="pro-plans-message" role="status">{message}</p>}
            <button
              type="button"
              className="primary-btn pro-plans-buy"
              onClick={handleBuy}
              disabled={!selected || Boolean(busy)}
            >
              {buyLabel}
            </button>
            {renewingNames.length > 0 && (
              <p className="pro-plans-fine">
                {joinNames(renewingNames)} {renewingNames.length > 1 ? 'renew' : 'renews'} on {renewingNames.length > 1 ? 'their' : 'its'} own
                until you cancel. Cancel at least a day before the period ends, in Settings, under your name, then
                Subscriptions.
              </p>
            )}
            <div className="pro-plans-links">
              <button type="button" onClick={handleRestore} disabled={Boolean(busy)}>
                {busy === 'restore' ? 'Restoring…' : 'Restore purchases'}
              </button>
              <button type="button" onClick={() => openPage('/terms')} disabled={busy === 'buy'}>Terms of Use</button>
              <button type="button" onClick={() => openPage('/privacy')} disabled={busy === 'buy'}>Privacy Policy</button>
            </div>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

ProPlansSheet.propTypes = {
  onClose: PropTypes.func.isRequired,
  /** Called with RevenueCat's CustomerInfo after a purchase or a restore. */
  onCustomerInfo: PropTypes.func.isRequired,
};
