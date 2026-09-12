import { createPortal } from 'react-dom';
import PropTypes from 'prop-types';

/**
 * Renders full screen overlays as children of <body>.
 *
 * `position: fixed` resolves against the viewport only while no ancestor has a
 * transform, filter or will-change. Every page in this app animates in with a
 * translate, which makes its container the containing block for anything fixed
 * inside it, so a backdrop with `inset: 0` covers the page's box rather than
 * the screen: the blur stopped short of the top and side edges and left a strip
 * of sharp page around it. A portal takes the overlay out of that box.
 */
export default function Overlay({ children }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}

Overlay.propTypes = {
  children: PropTypes.node,
};

Overlay.defaultProps = {
  children: null,
};
