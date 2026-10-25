import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import PropTypes from 'prop-types';
import { getAvatarIconById, DEFAULT_AVATAR_BACKGROUND, DEFAULT_AVATAR_COLOR, AVATAR_ICONS } from '../constants/avatarOptions';

/**
 * Unified avatar component. Renders a real photo (if photoURL is set) or
 * the existing icon-based avatar as a fallback. Drop-in replacement for any
 * inline avatar div: pass the same className and style as before.
 *
 * The outer element (div or img wrapper div) receives className + style so all
 * existing CSS rules for sizing, border-radius, shadows, etc. continue to work.
 * The inner <img> uses border-radius: inherit to clip correctly without needing
 * overflow: hidden on the parent.
 */
export default function AvatarDisplay({
  photoURL = null,
  avatarIcon = null,
  avatarBackground = null,
  avatarColor = null,
  className = '',
  style = undefined,
  alt = 'Profile photo',
  fallbackText = null,
  ...rest
}) {
  if (photoURL) {
    return (
      <div className={className} style={style} {...rest}>
        <img
          src={photoURL}
          alt={alt}
          draggable={false}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            borderRadius: 'inherit',
          }}
        />
      </div>
    );
  }

  const icon = getAvatarIconById(avatarIcon || AVATAR_ICONS[0].id);
  const bg = avatarBackground || DEFAULT_AVATAR_BACKGROUND;
  const color = avatarColor || DEFAULT_AVATAR_COLOR;

  return (
    <div className={className} style={{ background: bg, color, ...style }} {...rest}>
      {icon
        ? <FontAwesomeIcon icon={icon} />
        : fallbackText
          ? <span aria-hidden="true">{fallbackText}</span>
          : null}
    </div>
  );
}

AvatarDisplay.propTypes = {
  photoURL: PropTypes.string,
  avatarIcon: PropTypes.string,
  avatarBackground: PropTypes.string,
  avatarColor: PropTypes.string,
  className: PropTypes.string,
  style: PropTypes.object,
  alt: PropTypes.string,
  fallbackText: PropTypes.string,
};
