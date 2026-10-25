import PropTypes from 'prop-types';

/**
 * Small inline "Pro" badge shown next to pro users' names.
 * Pass subscription object or tier string.
 */
export default function ProBadge({ subscription = null, className = '' }) {
  const tier = typeof subscription === 'string'
    ? subscription
    : subscription?.tier;
  if (tier !== 'premium') return null;
  return (
    <span className={`pro-badge${className ? ` ${className}` : ''}`} aria-label="Pro user">
      Pro
    </span>
  );
}

ProBadge.propTypes = {
  subscription: PropTypes.oneOfType([
    PropTypes.shape({ tier: PropTypes.string }),
    PropTypes.string,
  ]),
  className: PropTypes.string,
};
